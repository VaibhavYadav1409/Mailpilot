import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decryptToken } from "../lib/crypto";
import { htmlToPlainText } from "../lib/htmlToText";
import { isPromotionalEmail, headerValue } from "./promoDetector";
import type { GmailAccount } from "../generated/prisma/client";
import type { ImapSentMessageMeta } from "./replyTracking";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB per attachment

// Folder names to fall back to (in order) when the server doesn't advertise
// a \Sent special-use mailbox (see findSentMailboxPath) — covers the common
// non-Gmail cases (generic IMAP, Outlook/Exchange) plus Gmail's own IMAP
// bridge naming, in case someone connects a Gmail account this way instead
// of through OAuth.
const SENT_FOLDER_FALLBACKS = ["Sent", "Sent Items", "Sent Messages", "[Gmail]/Sent Mail"];

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
  bodyHtml: string;
  snippet: string;
  attachments: ParsedImapAttachment[];
  // Deterministic promotional/bulk flag from List-Unsubscribe/Precedence
  // headers (IMAP has no Gmail-style category labels). See promoDetector.ts.
  isPromotional: boolean;
}

function buildClient(account: GmailAccount): ImapFlow {
  if (!account.imapHost || !account.imapPort || !account.imapUser) {
    throw new Error("IMAP account is missing connection details. Please reconnect.");
  }
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure ?? true,
    auth: { user: account.imapUser, pass: decryptToken(account.accessToken) },
    logger: false,
  });
}

/**
 * Splits a raw In-Reply-To / References header value into individual
 * Message-IDs. mailparser gives `inReplyTo` back as a single string and
 * `references` as either a single string or string[] depending on whether
 * the header had one id or several, so this normalizes all of those shapes
 * to a flat, trimmed array (each entry keeping its original "<...>"
 * wrapping, since that's how Email.gmailMessageId stores a message's own id
 * — see fetchImapMessages below — and matching needs exact string equality).
 */
function normalizeMessageIds(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : value.split(/\s+/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Finds the mailbox path for the account's "Sent" folder. Prefers the
 * server-advertised \Sent special-use flag (RFC 6154), since folder naming
 * otherwise varies a lot across providers; falls back to a list of common
 * names for servers that don't advertise special-use.
 */
async function findSentMailboxPath(client: ImapFlow): Promise<string | null> {
  const mailboxes = await client.list();
  const special = mailboxes.find((box) => box.specialUse === "\\Sent");
  if (special) return special.path;

  const byName = mailboxes.find((box) => SENT_FOLDER_FALLBACKS.includes(box.name) || SENT_FOLDER_FALLBACKS.includes(box.path));
  return byName?.path ?? null;
}

/**
 * Fetches messages received since the account's last sync (or the last 30
 * days on first sync) from the mailbox's INBOX. Kept intentionally simple —
 * one folder, most-recent-first, capped at 100 messages per run — mirroring
 * the scope of Gmail sync in emailSync.ts rather than building a full
 * multi-folder IMAP client.
 */
export async function fetchImapMessages(account: GmailAccount): Promise<ParsedImapMessage[]> {
  const client = buildClient(account);

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

        // mailparser gives `text` when a text/plain part exists and `html`
        // (string, or `false` when there is none) when an HTML part exists.
        // A large share of real mail is HTML-only, so text alone was
        // previously leaving bodyText empty for those messages — same issue
        // as the Gmail path in emailSync.ts, same fix.
        const htmlPart = typeof parsed.html === "string" ? parsed.html : "";
        const bodyText = parsed.text || (htmlPart ? htmlToPlainText(htmlPart) : "");
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
          bodyHtml: htmlPart,
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
          isPromotional: isPromotionalEmail({
            listUnsubscribe: headerValue(parsed.headers, "list-unsubscribe"),
            precedence: headerValue(parsed.headers, "precedence"),
            autoSubmitted: headerValue(parsed.headers, "auto-submitted"),
            bodyText,
            bodyHtml: htmlPart,
          }),
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

/**
 * Same fetch/parse as fetchImapMessages, but invokes `onMessage` for each
 * message as soon as it's parsed instead of accumulating everything into an
 * array first. A full mailbox sync can hold up to 100 messages' worth of
 * bodies, HTML, and attachment buffers (up to 25MB each) at once with the
 * batch version — on a fresh sync (lastSyncedAt reset, pulling 30 days) that
 * was enough to exceed Render's 512MB instance limit. Letting the caller
 * persist and discard each message immediately keeps peak memory to roughly
 * one message at a time regardless of mailbox size.
 */
export async function fetchImapMessagesStreaming(
  account: GmailAccount,
  onMessage: (message: ParsedImapMessage) => Promise<void>
): Promise<number> {
  const client = buildClient(account);

  const sinceDate = account.lastSyncedAt ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  let count = 0;

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

        const htmlPart = typeof parsed.html === "string" ? parsed.html : "";
        const bodyText = parsed.text || (htmlPart ? htmlToPlainText(htmlPart) : "");

        await onMessage({
          imapMessageId: parsed.messageId || `${account.id}-${uid}`,
          threadId: parsed.messageId || `${account.id}-${uid}`,
          fromAddress: fromAddr?.address || "unknown@unknown",
          fromName: fromAddr?.name || null,
          toAddresses,
          subject: parsed.subject || null,
          isRead: !!msg.flags?.has("\\Seen"),
          internalDate: parsed.date || new Date(),
          bodyText,
          bodyHtml: htmlPart,
          snippet: bodyText.slice(0, 160),
          attachments: (parsed.attachments || [])
            .filter((a) => !a.contentDisposition || a.contentDisposition === "attachment")
            .filter((a) => a.content.byteLength <= MAX_ATTACHMENT_BYTES)
            .map((a) => ({
              filename: a.filename || "attachment",
              mimeType: a.contentType || "application/octet-stream",
              content: a.content,
            })),
          isPromotional: isPromotionalEmail({
            listUnsubscribe: headerValue(parsed.headers, "list-unsubscribe"),
            precedence: headerValue(parsed.headers, "precedence"),
            autoSubmitted: headerValue(parsed.headers, "auto-submitted"),
            bodyText,
            bodyHtml: htmlPart,
          }),
        });
        count++;
        // parsed/msg go out of scope here and become eligible for GC before
        // the next iteration fetches the following message.
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return count;
}

/**
 * Fetches messages sent since the account's last sync (or the last 30 days
 * on first sync) from the mailbox's Sent folder, reduced to what
 * matchImapReplies (replyTracking.ts) needs to match them back to inbound
 * emails: the sent message's own id plus the In-Reply-To/References headers
 * pointing at whatever it was replying to. Mirrors fetchImapMessages'
 * connection handling and 100-message cap, just pointed at a different
 * folder and returning a much smaller shape (no body/attachments — sent
 * mail is only ever used for reply detection, never displayed itself).
 *
 * Returns an empty array (rather than throwing) if the account has no
 * discoverable Sent folder, since some minimal/misconfigured IMAP servers
 * genuinely don't have one — that just means reply detection for this
 * account silently finds nothing, same as if it had never synced replies.
 */
export async function fetchImapSentMessages(account: GmailAccount): Promise<ImapSentMessageMeta[]> {
  const client = buildClient(account);

  const sinceDate = account.lastSyncedAt ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  const results: ImapSentMessageMeta[] = [];

  try {
    await client.connect();
    const sentPath = await findSentMailboxPath(client);
    if (!sentPath) return results;

    const lock = await client.getMailboxLock(sentPath);
    try {
      const uids = await client.search({ since: sinceDate }, { uid: true });
      const capped = (Array.isArray(uids) ? uids : []).slice(-100);

      for (const uid of capped) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);
        results.push({
          imapMessageId: parsed.messageId || `${account.id}-sent-${uid}`,
          inReplyTo: normalizeMessageIds(parsed.inReplyTo),
          references: normalizeMessageIds(parsed.references),
          sentDate: parsed.date || new Date(),
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
