// Reused from mailpilot-client-updated/server/_core/gmail.ts: the token
// exchange/refresh calls against Google's endpoint are unchanged. What's
// different: credentials are no longer read from a single global Settings
// row, and tokens are never returned to the caller in plaintext — every
// caller in this backend goes through gmailAccountService.getValidAccessToken.

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4000/api/gmail/callback";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars are required");
  }
  return { clientId, clientSecret };
}

/** Used by GET /api/gmail/status so the employee-app can show "Connect Gmail" vs a setup hint. */
export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function buildAuthUrl(state: string): string {
  const { clientId } = getCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  emailAddress: string;
}

export async function exchangeCode(code: string): Promise<TokenExchangeResult> {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };

  const emailAddress = await fetchEmailAddress(json.access_token);

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in,
    emailAddress,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // Google returns 400 invalid_grant when a refresh token has been revoked
    // (user removed app access, or password/security changes invalidated it).
    // Callers use this to distinguish "transient network issue" from "user
    // needs to reconnect."
    const body = await res.text();
    const err = new Error(`Google token refresh failed: ${body}`);
    (err as any).isInvalidGrant = res.status === 400 && body.includes("invalid_grant");
    throw err;
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

async function fetchEmailAddress(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch Gmail account email address");
  const json = (await res.json()) as { email: string };
  return json.email;
}
