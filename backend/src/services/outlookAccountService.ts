import type { GmailAccount } from "../generated/prisma";
import { prisma } from "../lib/db";
import { encryptToken, decryptToken } from "../lib/crypto";
import { exchangeCode, refreshAccessToken, type TokenExchangeResult } from "./microsoftOAuth";
import { deactivateOtherAccounts } from "./gmailAccountService";
import { emitToCompany } from "../sockets";

// Microsoft's IMAP endpoint. Same host for personal Outlook.com and
// Microsoft 365 mailboxes.
const OUTLOOK_IMAP_HOST = "outlook.office365.com";
const OUTLOOK_IMAP_PORT = 993;

/**
 * Connects an Outlook.com / Microsoft 365 mailbox via OAuth2. Mirrors
 * connectGmailAccount, but the account is stored as provider OUTLOOK with
 * IMAP connection details filled in — sync goes through the IMAP path
 * (imapSync.ts), authenticating with the OAuth access token (XOAUTH2)
 * rather than a password. Only one account per employee stays isActive.
 */
export async function connectOutlookAccount(employeeId: string, companyId: string, code: string) {
  const tokens: TokenExchangeResult = await exchangeCode(code);

  if (!tokens.refreshToken) {
    // offline_access is in the requested scopes, so Microsoft should always
    // return a refresh token. Without one the connection dies as soon as the
    // access token expires (~1 hour) with no way to renew it.
    throw new Error(
      "Microsoft did not return a refresh token. Remove MailPilot from your Microsoft account permissions (account.live.com/consent/Manage) and reconnect."
    );
  }

  const existingForMailbox = await prisma.gmailAccount.findUnique({
    where: { emailAddress: tokens.emailAddress },
  });
  const genuinelyOwnedByAnother =
    existingForMailbox &&
    existingForMailbox.employeeId !== employeeId &&
    existingForMailbox.status !== "DISCONNECTED";
  if (genuinelyOwnedByAnother) {
    throw new Error(
      `${tokens.emailAddress} is already connected to a different employee. Disconnect it there first.`
    );
  }

  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

  const data = {
    provider: "OUTLOOK" as const,
    employeeId,
    companyId,
    accessToken: encryptToken(tokens.accessToken),
    refreshToken: encryptToken(tokens.refreshToken),
    tokenExpiresAt: expiresAt,
    status: "CONNECTED" as const,
    isActive: true,
    imapHost: OUTLOOK_IMAP_HOST,
    imapPort: OUTLOOK_IMAP_PORT,
    imapUser: tokens.emailAddress,
    imapSecure: true,
  };

  const account = existingForMailbox
    ? await prisma.gmailAccount.update({ where: { id: existingForMailbox.id }, data })
    : await prisma.gmailAccount.create({
        data: { emailAddress: tokens.emailAddress, lastSyncedAt: null, ...data },
      });

  await deactivateOtherAccounts(employeeId, account.id);

  return { id: account.id, emailAddress: account.emailAddress, status: account.status };
}

/**
 * Ensures the given OUTLOOK account row has a currently-valid access token,
 * refreshing (and persisting the rotated refresh token) if it's within 60s
 * of expiry. Returns the up-to-date account row so callers (emailSync →
 * imapSync.buildClient) can read the fresh encrypted accessToken straight
 * off it. Throws if the refresh token is no longer valid, after marking the
 * account REVOKED and notifying admins — same behaviour as the Gmail path.
 */
export async function ensureFreshOutlookAccount(account: GmailAccount): Promise<GmailAccount> {
  const stillValid = account.tokenExpiresAt.getTime() > Date.now() + 60_000;
  if (stillValid) return account;

  try {
    const currentRefresh = decryptToken(account.refreshToken);
    const refreshed = await refreshAccessToken(currentRefresh);
    return await prisma.gmailAccount.update({
      where: { id: account.id },
      data: {
        accessToken: encryptToken(refreshed.accessToken),
        // Persist the rotated refresh token when Microsoft returns one;
        // otherwise keep the existing one.
        ...(refreshed.refreshToken ? { refreshToken: encryptToken(refreshed.refreshToken) } : {}),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        status: "CONNECTED",
      },
    });
  } catch (err: any) {
    if (err.isInvalidGrant) {
      await markOutlookRevoked(account);
      throw new Error("Outlook connection expired — please reconnect.");
    }
    throw err;
  }
}

async function markOutlookRevoked(account: GmailAccount) {
  await prisma.gmailAccount.update({ where: { id: account.id }, data: { status: "REVOKED" } });

  const employee = await prisma.employee.findUnique({ where: { id: account.employeeId } });
  const message = `${employee ? `${employee.firstName} ${employee.lastName}` : "An employee"}'s Outlook connection (${account.emailAddress}) was revoked and needs to be reconnected.`;

  const notification = await prisma.notification.create({
    data: { companyId: account.companyId, type: "GMAIL_DISCONNECTED", severity: "WARNING", message },
  });
  emitToCompany(account.companyId, "notification:new", notification);
}
