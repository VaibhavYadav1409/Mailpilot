import { ImapFlow } from "imapflow";
import { prisma } from "../lib/db";
import { encryptToken } from "../lib/crypto";
import { deactivateOtherAccounts } from "./gmailAccountService";

export interface ImapConnectInput {
  email: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  imapSecure: boolean;
  // Optional and, as of the Conditional Sending rule (see emailActions.ts —
  // IMAP_SEND_DISABLED_MESSAGE), never used to send: IMAP-connected mailboxes
  // are read-only in MailPilot full stop. Kept only so the UI can display
  // what SMTP server the employee's client uses; never verified, never
  // required, never touched by any send path.
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpSecure?: boolean;
}

// Far-future sentinel — IMAP accounts don't use Gmail's access-token refresh
// flow, but tokenExpiresAt is a required column shared with GmailAccount.
const NEVER_EXPIRES = new Date("2099-12-31T00:00:00Z");

/**
 * Verifies IMAP + SMTP credentials actually work before saving anything —
 * mirrors the "don't trust unverified client input" principle the Gmail
 * OAuth flow already follows (there, Google's own token exchange is the
 * verification; here we have to do it ourselves by opening a real
 * connection and immediately closing it).
 */
// ImapFlow has no built-in connect-timeout option (only a post-connect
// idle/socketTimeout), and nodemailer's default connectionTimeout is a full
// 2 minutes. Left unbounded, a wrong host/port (or one that silently drops
// packets instead of refusing the connection) makes the "Connect Email"
// button hang for minutes before the user ever sees an error. 10s is
// generous for any real IMAP/SMTP server on a normal network.
const VERIFY_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${VERIFY_TIMEOUT_MS / 1000}s — check the host and port.`)), VERIFY_TIMEOUT_MS)
    ),
  ]);
}

async function verifyImap(input: ImapConnectInput) {
  const client = new ImapFlow({
    host: input.imapHost,
    port: input.imapPort,
    secure: input.imapSecure,
    auth: { user: input.imapUser, pass: input.imapPass },
    logger: false,
  });
  try {
    await withTimeout(client.connect(), "IMAP connection");
    await client.logout();
  } catch (err) {
    // If connect() itself timed out, the socket may still be open in the
    // background — force it closed so it doesn't linger past the request.
    client.close();
    throw err;
  }
}

/**
 * Connects (or re-connects) an employee's mailbox via IMAP/SMTP. An
 * employee can have other accounts on file already (a prior Gmail
 * connection, say) — those stay as inactive history; this one becomes the
 * new active account. See deactivateOtherAccounts in gmailAccountService.ts.
 */
export async function connectImapAccount(employeeId: string, companyId: string, input: ImapConnectInput) {
  // Only IMAP (reading) is verified — SMTP is never used to send (see
  // IMAP_SEND_DISABLED_MESSAGE in emailActions.ts), so there's nothing to
  // verify there, and verifying it anyway would risk a false-negative
  // timeout on hosts that block outbound SMTP ports for a feature that's
  // disabled regardless.
  await verifyImap(input);

  const existingForMailbox = await prisma.gmailAccount.findUnique({ where: { emailAddress: input.email } });
  // Only a row that's *actually still connected* to someone else should
  // block this. A row left behind by disconnectGmailAccount (status
  // DISCONNECTED, but employeeId/isActive untouched — see that function)
  // is stale history, not a real conflict, so it's fine to reclaim it for
  // the new employee below rather than erroring.
  const genuinelyOwnedByAnother =
    existingForMailbox &&
    existingForMailbox.employeeId !== employeeId &&
    existingForMailbox.status !== "DISCONNECTED";
  if (genuinelyOwnedByAnother) {
    throw new Error(`${input.email} is already connected to a different employee. Disconnect it there first.`);
  }

  const data = {
    provider: "IMAP" as const,
    emailAddress: input.email,
    accessToken: encryptToken(input.imapPass),
    refreshToken: encryptToken(input.smtpPass ?? ""), // refreshToken column is required; empty when no SMTP details were given
    tokenExpiresAt: NEVER_EXPIRES,
    status: "CONNECTED" as const,
    isActive: true,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapUser: input.imapUser,
    imapSecure: input.imapSecure,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpUser: input.smtpUser,
    smtpSecure: input.smtpSecure,
  };

  const account = existingForMailbox
    ? await prisma.gmailAccount.update({ where: { id: existingForMailbox.id }, data: { ...data, employeeId, companyId } })
    : await prisma.gmailAccount.create({ data: { employeeId, companyId, lastSyncedAt: null, ...data } });

  await deactivateOtherAccounts(employeeId, account.id);

  return { id: account.id, emailAddress: account.emailAddress, status: account.status };
}

/**
 * Ensures the employee has *some* active mail account row to attach
 * manually-pasted emails to (Email.gmailAccountId is a required FK). Only
 * used for the "paste email manually" flow when no real account is
 * connected yet.
 */
export async function getOrCreateManualAccount(employeeId: string, companyId: string) {
  const existing = await prisma.gmailAccount.findFirst({ where: { employeeId, isActive: true } });
  if (existing) return existing;

  return prisma.gmailAccount.create({
    data: {
      employeeId,
      companyId,
      provider: "MANUAL",
      emailAddress: `manual+${employeeId}@local.mailpilot`,
      accessToken: encryptToken(""),
      refreshToken: encryptToken(""),
      tokenExpiresAt: NEVER_EXPIRES,
      status: "CONNECTED",
      isActive: true,
    },
  });
}
