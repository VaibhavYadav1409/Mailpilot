// Microsoft (Outlook.com / Microsoft 365) OAuth for IMAP access. Mirrors the
// shape of googleOAuth.ts so gmailAccountService / the connect routes can use
// the same flow, but talks to the Microsoft identity platform (v2.0) and
// requests the Outlook IMAP delegated scope instead of Gmail's API scopes.
//
// Why OAuth at all: Microsoft disabled Basic Authentication (plain
// username/password, and app passwords) for personal Outlook.com and
// Exchange Online accounts, so IMAP now requires an OAuth2 access token
// (XOAUTH2). See imapSync.buildClient for where the token is actually used.

const REDIRECT_URI = process.env.MS_REDIRECT_URI ?? "http://localhost:4000/api/outlook/callback";

// "common" lets both personal Microsoft accounts (outlook.com/hotmail/live)
// and any org's Microsoft 365 accounts sign in — matches the "Any Entra ID
// tenant + personal Microsoft accounts" app registration.
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";

// IMAP.AccessAsUser.All is the delegated Outlook IMAP scope. offline_access
// is what makes Microsoft return a refresh_token; openid/email/profile give
// us an id_token we can read the mailbox address off of (the access token's
// audience is Outlook, not Graph, so we can't call Graph /me with it).
// NOTE the host: personal Outlook.com/Hotmail/Live accounts expect the scope
// on outlook.office.com. The outlook.office365.com form is only valid for
// Microsoft 365 org tenants and is rejected for consumer accounts
// (AADSTS1002012 "the provided value for scope ... is not valid"), which
// bounces the user straight back with no password prompt.
// openid/offline_access/email/profile are OIDC scopes and are exempt from
// the "one resource per request" rule, so they're safe to request alongside.
// Microsoft Graph, NOT the Exchange IMAP scope. Personal (consumer)
// Outlook.com accounts are not eligible for OAuth over IMAP — Microsoft
// states OAuth is unsupported for POP/IMAP on Outlook.com, and requesting
// https://outlook.office.com/IMAP.AccessAsUser.All for a consumer account
// returns access_denied no matter how the app is registered. Graph supports
// personal accounts directly with delegated Mail.Read and requires no
// Exchange Online service principal in the tenant.
//
// User.Read is what lets us resolve the mailbox address via /me.
const SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  // Mail.Send powers replying from inside MailPilot (see sendGraphReply).
  // Accounts connected before this scope was added must reconnect — their
  // existing refresh token carries the old, narrower consent.
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
  "openid",
].join(" ");

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("MS_CLIENT_ID / MS_CLIENT_SECRET env vars are required");
  }
  return { clientId, clientSecret };
}

/** Used by GET /api/outlook/status so the employee-app can show "Connect Outlook" vs a setup hint. */
export function isMicrosoftConfigured(): boolean {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

export function buildAuthUrl(state: string): string {
  const { clientId } = getCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
    state,
    // Force the account chooser so connecting a second mailbox doesn't
    // silently reuse the browser's already-signed-in Microsoft account.
    prompt: "select_account",
  });
  return `${AUTHORITY}/authorize?${params}`;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  emailAddress: string;
}

/** Decodes a JWT payload (no signature check — the token came straight from
 *  Microsoft over TLS, we're only reading the email claim, not trusting it
 *  for authz). */
function decodeJwtPayload(jwtStr: string): Record<string, unknown> {
  const part = jwtStr.split(".")[1];
  if (!part) return {};
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function claimEmail(token: string | undefined): string | null {
  if (!token) return null;
  const c = decodeJwtPayload(token);
  const email =
    (c.email as string | undefined) ||
    (c.preferred_username as string | undefined) ||
    (c.upn as string | undefined) ||
    (c.unique_name as string | undefined);
  return email && email.includes("@") ? email.toLowerCase() : null;
}

/** Asks Graph who the token belongs to. Authoritative, and the reason
 *  User.Read is in SCOPES. */
async function fetchEmailFromGraph(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
    // Personal accounts often leave `mail` null and carry the address in
    // userPrincipalName instead.
    const email = json.mail || json.userPrincipalName;
    return email && email.includes("@") ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Works out which mailbox was just connected: Graph /me first, then the
 * id_token, then the access token's claims. The layered fallback exists
 * because personal and work accounts populate these differently, and
 * failing the whole connect over a missing claim — when we already hold a
 * working mail token — would be needlessly brittle.
 */
async function resolveEmailAddress(idToken: string | undefined, accessToken: string): Promise<string> {
  const email = (await fetchEmailFromGraph(accessToken)) ?? claimEmail(idToken) ?? claimEmail(accessToken);
  if (!email) {
    throw new Error(
      "Connected to Microsoft, but couldn't determine the mailbox address. Please report this."
    );
  }
  return email;
}

export async function exchangeCode(code: string): Promise<TokenExchangeResult> {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
      scope: SCOPES,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[outlook] token exchange failed:", body);
    throw new Error(`Microsoft token exchange failed: ${body}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in,
    emailAddress: await resolveEmailAddress(json.id_token, json.access_token),
  };
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      scope: SCOPES,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Microsoft token refresh failed: ${body}`);
    // AADSTS700082 (expired), invalid_grant, or a revoked/consent-withdrawn
    // refresh token → the user must reconnect. Callers use this to
    // distinguish "reconnect needed" from a transient network blip.
    (err as any).isInvalidGrant =
      res.status === 400 && (body.includes("invalid_grant") || body.includes("AADSTS"));
    throw err;
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  // Microsoft rotates refresh tokens — a refresh response usually contains a
  // NEW refresh_token that supersedes the one we sent. Return it so the
  // caller can persist it; falling back to null means "keep the old one".
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in,
  };
}
