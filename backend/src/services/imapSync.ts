import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decryptToken } from "../lib/crypto";
import type { GmailAccount } from "../generated/prisma/client";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB per attachment

export interface ParsedImapAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface ParsedImapMessage {
  imapMessageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string | null;
  isRead: boolean;
  internalDate: Date;
  bodyText: string;
  snippet: string;
  attachments: ParsedImapAttachment[];
}

/**
 * Fetches messages received since the account's last sync (or the last 30
 * days on first sync) from the mailbox's INBOX. Kept intentionally simple —
 * one folder, most-recent-first, capped at 100 messages per run — mirroring
 * the scope of Gmail sync in emailSync.ts rather than building a full
 * multi-folder IMAP client.
 */
export async function fetchImapMessages(account: GmailAccount): Promise<ParsedImapMessage[]> {
  if (!account.imapHost || !account.imapPort || !account.imapUser) {
    throw new Error("IMAP account is missing connection details. Please reconnect.");
  }

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure ?? true,
    auth: { user: account.imapUser, pass: decryptToken(account.accessToken) },
    logger: false,
  });

  const sinceDate = account.lastSyncedAt ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  const results: ParsedImapMessage[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since: sinceDate }, { uid: true });
      const capped = (Array.isArray(uids) ? uids : []).slice(-100); // most recent 100

      for (const uid of capped) {
        const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.value?.[0];
        const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
        const toAddresses = toList.flatMap((t) => t.value.map((v) => v.address ?? "")).filter(Boolean);

        const bodyText = parsed.text || "";
        results.push({
          imapMessageId: parsed.messageId || `${account.id}-${uid}`,
          threadId: parsed.messageId || `${account.id}-${uid}`,
          fromAddress: fromAddr?.address || "unknown@unknown",
          fromName: fromAddr?.name || null,
          toAddresses,
          subject: parsed.subject || null,
          isRead: !!msg.flags?.has("\\Seen"),
          internalDate: parsed.date || new Date(),
          bodyText,
          snippet: bodyText.slice(0, 160),
          attachments: (parsed.attachments || [])
            // Inline images referenced by cid (signatures, tracking pixels)
            // aren't "attachments" from the user's point of view — only
            // surface things mailparser itself doesn't mark as inline content.
            .filter((a) => !a.contentDisposition || a.contentDisposition === "attachment")
            // Cap per-attachment size so one oversized file can't blow up
            // memory during sync; large files should be shared via a link,
            // not this pipeline.
            .filter((a) => a.content.byteLength <= MAX_ATTACHMENT_BYTES)
            .map((a) => ({
              filename: a.filename || "attachment",
              mimeType: a.contentType || "application/octet-stream",
              content: a.content,
            })),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return results;
}
