/**
 * What a failed token refresh from Microsoft / Google really means, in plain
 * words — so an account is only marked "needs reconnect" (REVOKED) when the
 * mailbox's sign-in is really gone, never for a temporary error or a problem
 * with MailPilot's own app registration, and so the admin page can say why.
 */
export type TokenFailure = "RECONNECT" | "APP_CONFIG" | "TRANSIENT";

export interface TokenErrorInfo {
  kind: TokenFailure;
  /** Plain-English reason shown to admins. */
  reason: string;
  /** e.g. "AADSTS50173" or "invalid_grant". */
  code: string | null;
}

const MS_REASONS: [number[], TokenFailure, string][] = [
  [[50173, 50133, 50055, 50053, 50126], "RECONNECT", "the mailbox password was changed or reset (or the account was locked)"],
  [[700082, 70008, 700084, 70043], "RECONNECT", "the sign-in expired after a long time without use"],
  [[65001, 65004], "RECONNECT", "the permission for MailPilot was removed or never granted for this mailbox"],
  [[50076, 50079, 50078, 50158], "RECONNECT", "Microsoft now asks for extra verification (MFA) for this mailbox"],
  [[53003, 53000, 53001, 530003], "RECONNECT", "the company's Microsoft 365 access policy blocked the sign-in"],
  [[50057], "RECONNECT", "the Microsoft account is disabled"],
  [[50034], "RECONNECT", "the Microsoft account no longer exists"],
  [[7000215, 7000222, 700016, 7000218, 700027, 90002], "APP_CONFIG", "MailPilot's Microsoft app secret/registration is invalid or expired — an admin must renew it in Azure (the mailboxes themselves are fine)"],
];

/** Microsoft identity platform error (JSON body of a failed /token call). */
export function explainMicrosoftTokenError(status: number, body: string): TokenErrorInfo {
  let json: { error?: string; error_description?: string; error_codes?: number[] } = {};
  try {
    json = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  const codes = json.error_codes ?? [...body.matchAll(/AADSTS(\d+)/g)].map((m) => Number(m[1]));
  const code = codes.length ? `AADSTS${codes[0]}` : json.error ?? null;
  for (const [list, kind, text] of MS_REASONS) {
    if (codes.some((c) => list.includes(c))) return { kind, reason: `Microsoft says ${text} (${`AADSTS${codes.find((c) => list.includes(c))}`}).`, code };
  }
  if (status >= 500 || json.error === "temporarily_unavailable" || json.error === "server_error") {
    return { kind: "TRANSIENT", reason: "Microsoft was temporarily unavailable.", code };
  }
  if (json.error === "invalid_client" || json.error === "unauthorized_client") {
    return { kind: "APP_CONFIG", reason: `MailPilot's Microsoft app registration was rejected (${code}) — an admin must check it in Azure.`, code };
  }
  if (json.error === "invalid_grant") {
    return { kind: "RECONNECT", reason: `Microsoft no longer accepts this mailbox's sign-in (${code}).`, code };
  }
  return { kind: "TRANSIENT", reason: `Microsoft refused the token refresh (${code ?? status}).`, code };
}

/** Google OAuth error (JSON body of a failed /token call). */
export function explainGoogleTokenError(status: number, body: string): TokenErrorInfo {
  let json: { error?: string; error_description?: string } = {};
  try {
    json = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  if (json.error === "invalid_grant" || (status === 400 && body.includes("invalid_grant"))) {
    return {
      kind: "RECONNECT",
      reason:
        "Google no longer accepts this mailbox's sign-in — access was removed, the password was changed, or the Google app is still in \"Testing\" mode (sign-ins then expire after 7 days).",
      code: "invalid_grant",
    };
  }
  if (json.error === "invalid_client" || json.error === "unauthorized_client") {
    return { kind: "APP_CONFIG", reason: "MailPilot's Google app credentials were rejected — an admin must check them in Google Cloud.", code: json.error };
  }
  return { kind: "TRANSIENT", reason: `Google refused the token refresh (${json.error ?? status}).`, code: json.error ?? null };
}
