import { prisma } from "../lib/db";
import { encryptToken, decryptToken } from "../lib/crypto";
import { exchangeCode, refreshAccessToken, type TokenExchangeResult } from "./googleOAuth";
import { emitToCompany } from "../sockets";

/**
 * Deactivates every currently-active mail account for an employee except
 * (optionally) the one at `keepAccountId`. Used when connecting a new
 * account — the employee can have several GmailAccount rows over time
 * (account switching: e.g. IMAP first, then Gmail later), but only one
 * should be isActive at once, since that's what sync/send/status all key
 * off. Deactivated rows are never deleted — their already-synced Email
 * history stays intact and queryable, just excluded from "current" views.
 */
export async function deactivateOtherAccounts(employeeId: string, keepAccountId?: string) {
  await prisma.gmailAccount.updateMany({
    where: { employeeId, isActive: true, ...(keepAccountId ? { id: { not: keepAccountId } } : {}) },
    data: { isActive: false },
  });
}

/**
 * Connects a Gmail account to an employee. An employee can have connected
 * other accounts before (IMAP, or a different Gmail address) — those stay
 * on file as inactive history; this one becomes the new active account.
 * A given mailbox (emailAddress) still can't be connected to two different
 * employees at once — GmailAccount.emailAddress is @unique in the schema,
 * so that half is enforced at the DB level; this adds the friendlier
 * application-level check.
 */
export async function connectGmailAccount(employeeId: string, companyId: string, code: string) {
  const tokens: TokenExchangeResult = await exchangeCode(code);

  if (!tokens.refreshToken) {
    // Google omits refresh_token on re-consent if the user never revoked the
    // prior grant. We require offline access with prompt=consent (see
    // googleOAuth.buildAuthUrl), so this should be rare, but if it happens we
    // can't silently proceed — without a refresh token the connection dies
    // the moment the access token expires (~1 hour).
    throw new Error(
      "Google did not return a refresh token. Ask the employee to remove MailPilot's access in their Google Account permissions and reconnect."
    );
  }

  const existingForMailbox = await prisma.gmailAccount.findUnique({
    where: { emailAddress: tokens.emailAddress },
  });
  if (existingForMailbox && existingForMailbox.employeeId !== employeeId) {
    throw new Error(
      `${tokens.emailAddress} is already connected to a different employee. Disconnect it there first.`
    );
  }

  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

  // Reconnecting the exact same mailbox this employee already has on file
  // (existingForMailbox, employeeId matches) refreshes that row in place.
  // A genuinely new mailbox creates a new row. Either way, every other
  // account this employee has gets deactivated afterward so there's only
  // ever one active account at a time.
  const account = existingForMailbox
    ? await prisma.gmailAccount.update({
        where: { id: existingForMailbox.id },
        data: {
          provider: "GMAIL",
          accessToken: encryptToken(tokens.accessToken),
          refreshToken: encryptToken(tokens.refreshToken),
          tokenExpiresAt: expiresAt,
          status: "CONNECTED",
          isActive: true,
        },
      })
    : await prisma.gmailAccount.create({
        data: {
          employeeId,
          companyId,
          provider: "GMAIL",
          emailAddress: tokens.emailAddress,
          accessToken: encryptToken(tokens.accessToken),
          refreshToken: encryptToken(tokens.refreshToken),
          tokenExpiresAt: expiresAt,
          status: "CONNECTED",
          isActive: true,
          lastSyncedAt: null,
        },
      });

  await deactivateOtherAccounts(employeeId, account.id);

  return { id: account.id, emailAddress: account.emailAddress, status: account.status };
}

/**
 * Returns a valid (non-expired) access token for the employee's currently
 * active Gmail account, refreshing it first if needed. Returns null if
 * there's no active connected account. Marks the account REVOKED and fires
 * an admin notification if Google reports the refresh token itself is no
 * longer valid (user revoked access, changed password, etc.) — this is the
 * "detect disconnected accounts, notify administrators" requirement.
 */
export async function getValidAccessToken(employeeId: string): Promise<string | null> {
  const account = await prisma.gmailAccount.findFirst({ where: { employeeId, isActive: true } });
  if (!account || account.status === "DISCONNECTED") return null;

  const stillValid = account.tokenExpiresAt.getTime() > Date.now() + 60_000;
  if (stillValid) {
    return decryptToken(account.accessToken);
  }

  try {
    const refreshToken = decryptToken(account.refreshToken);
    const refreshed = await refreshAccessToken(refreshToken);
    await prisma.gmailAccount.update({
      where: { id: account.id },
      data: {
        accessToken: encryptToken(refreshed.accessToken),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        status: "CONNECTED",
      },
    });
    return refreshed.accessToken;
  } catch (err: any) {
    if (err.isInvalidGrant) {
      await markRevoked(account.id, account.companyId, account.employeeId, account.emailAddress);
      return null;
    }
    // Transient failure (network, Google outage) — leave status as-is so we
    // retry next time rather than false-alarming admins.
    throw err;
  }
}

async function markRevoked(accountId: string, companyId: string, employeeId: string, emailAddress: string) {
  await prisma.gmailAccount.update({
    where: { id: accountId },
    data: { status: "REVOKED" },
  });

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });

  const message = `${employee ? `${employee.firstName} ${employee.lastName}` : "An employee"}'s Gmail connection (${emailAddress}) was revoked and needs to be reconnected.`;

  const notification = await prisma.notification.create({
    data: {
      companyId,
      type: "GMAIL_DISCONNECTED",
      severity: "WARNING",
      message,
    },
  });

  // Live-push to any open admin dashboard rather than waiting on their next poll.
  emitToCompany(companyId, "notification:new", notification);
}

/** Disconnects the employee's currently active mail account (whichever provider it is). */
export async function disconnectGmailAccount(employeeId: string) {
  await prisma.gmailAccount.updateMany({
    where: { employeeId, isActive: true },
    data: { status: "DISCONNECTED" },
  });
}
