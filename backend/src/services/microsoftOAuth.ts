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
const SCOPES = [
  "https://outlook.office365.com/IMAP.AccessAsUser.All",
  "offline_access",
  "openid",
  "email",
  "profile",
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

function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) throw new Error("Microsoft did not return an id_token — cannot determine the mailbox address.");
  const claims = decodeJwtPayload(idToken);
  const email =
    (claims.email as string | undefined) ||
    (claims.preferred_username as string | undefined) ||
    (claims.upn as string | undefined);
  if (!email) throw new Error("Could not read the email address from Microsoft's id_token.");
  return email.toLowerCase();
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
  if (!res.ok) throw new Error(`Microsoft token exchange failed: ${await res.text()}`);
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
    emailAddress: emailFromIdToken(json.id_token),
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
