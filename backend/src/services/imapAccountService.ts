import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { prisma } from "../lib/db";
import { encryptToken } from "../lib/crypto";

export interface ImapConnectInput {
  email: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: boolean;
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

async function verifySmtp(input: ImapConnectInput) {
  const transport = nodemailer.createTransport({
    host: input.smtpHost,
    port: input.smtpPort,
    secure: input.smtpSecure,
    auth: { user: input.smtpUser, pass: input.smtpPass },
    connectionTimeout: VERIFY_TIMEOUT_MS,
    greetingTimeout: VERIFY_TIMEOUT_MS,
    socketTimeout: VERIFY_TIMEOUT_MS,
  });
  await withTimeout(transport.verify(), "SMTP connection");
}

/**
 * Connects (or re-connects) an employee's mailbox via IMAP/SMTP. Enforces
 * the same "exactly one mail account per employee" rule as Gmail — connecting
 * IMAP after a prior Gmail/manual account replaces it, matching how
 * connectGmailAccount's upsert-by-employeeId already behaves.
 */
export async function connectImapAccount(employeeId: string, companyId: string, input: ImapConnectInput) {
  await Promise.all([verifyImap(input), verifySmtp(input)]);

  const existingForMailbox = await prisma.gmailAccount.findUnique({ where: { emailAddress: input.email } });
  if (existingForMailbox && existingForMailbox.employeeId !== employeeId) {
    throw new Error(`${input.email} is already connected to a different employee. Disconnect it there first.`);
  }

  const account = await prisma.gmailAccount.upsert({
    where: { employeeId },
    create: {
      employeeId,
      companyId,
      provider: "IMAP",
      emailAddress: input.email,
      accessToken: encryptToken(input.imapPass),
      refreshToken: encryptToken(input.smtpPass),
      tokenExpiresAt: NEVER_EXPIRES,
      status: "CONNECTED",
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapUser: input.imapUser,
      imapSecure: input.imapSecure,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpUser: input.smtpUser,
      smtpSecure: input.smtpSecure,
      lastSyncedAt: null,
    },
    update: {
      provider: "IMAP",
      emailAddress: input.email,
      accessToken: encryptToken(input.imapPass),
      refreshToken: encryptToken(input.smtpPass),
      tokenExpiresAt: NEVER_EXPIRES,
      status: "CONNECTED",
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapUser: input.imapUser,
      imapSecure: input.imapSecure,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpUser: input.smtpUser,
      smtpSecure: input.smtpSecure,
    },
  });

  return { id: account.id, emailAddress: account.emailAddress, status: account.status };
}

/**
 * Ensures the employee has *some* mail account row to attach manually-pasted
 * emails to (Email.gmailAccountId is a required FK). Only used for the
 * "paste email manually" flow when no real account is connected yet.
 */
export async function getOrCreateManualAccount(employeeId: string, companyId: string) {
  const existing = await prisma.gmailAccount.findUnique({ where: { employeeId } });
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
    },
  });
}
