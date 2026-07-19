import { prisma } from "../lib/db";
import { getValidAccessToken } from "./gmailAccountService";
import { fetchImapMessages, fetchImapSentMessages } from "./imapSync";
import { categorizeEmail, scoreEmailPriority } from "./aiPipeline";
import { makeStorageKey, writeAttachment } from "../lib/attachmentStorage";
import { matchGmailReplies, matchImapReplies, recordReply, refreshPendingDurations, type ReplyCandidate } from "./replyTracking";
import { htmlToPlainText } from "../lib/htmlToText";

/** A Gmail Sent-labeled message, reduced to just what thread-based reply matching needs. */
interface GmailSentMeta {
  threadId: string;
  internalDate: Date;
}

interface ParsedAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB per attachment, matches imapSync's cap

interface ParsedMessage {
  gmailMessageId: string;
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
  attachments: ParsedAttachment[];
}

/**
 * Walks the MIME tree collecting both text/plain and text/html parts.
 * Gmail messages are frequently HTML-only (marketing, invoices, most
 * templated notification mail) — previously only text/plain was collected,
 * so those messages synced with an empty bodyText: the reader pane fell
 * back to the truncated snippet, and every AI call (categorize/priority/
 * summary/reply) ran on effectively no content. When there's no text/plain
 * part, bodyText is now derived from the HTML instead of left empty.
 */
function extractBody(payload: any): { bodyText: string; bodyHtml: string } {
  let bodyText = "";
  let bodyHtml = "";
  const walk = (part: any) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      bodyText += Buffer.from(part.body.data, "base64").toString("utf-8");
    } else if (part.mimeType === "text/html" && part.body?.data) {
      bodyHtml += Buffer.from(part.body.data, "base64").toString("utf-8");
    }
    for (const sub of part.parts ?? []) walk(sub);
  };
  walk(payload);
  if (!bodyText && bodyHtml) bodyText = htmlToPlainText(bodyHtml);
  return { bodyText, bodyHtml };
}

interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

/** Collects attachment parts (anything with a filename + attachmentId) anywhere in the MIME tree, skipping inline/no-filename parts. */
function extractAttachmentRefs(payload: any): GmailAttachmentRef[] {
  const refs: GmailAttachmentRef[] = [];
  const walk = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      refs.push({ filename: part.filename, mimeType: part.mimeType || "application/octet-stream", attachmentId: part.body.attachmentId });
    }
    for (const sub of part.parts ?? []) walk(sub);
  };
  walk(payload);
  return refs;
}

async function fetchGmailAttachment(messageId: string, attachmentId: string, accessToken: string): Promise<Buffer | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const { data } = (await res.json()) as { data?: string };
  if (!data) return null;
  // Gmail's attachment API returns URL-safe base64.
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Lists message ids matching a Gmail search query, paginating through up to
 * `maxResults` ids in total. Shared by the inbox listing (below) and the
 * Sent-label listing used for reply detection, since both are "give me ids
 * for this query" with the same shape of request.
 *
 * Gmail's messages.list endpoint caps a single page at 100 results and
 * signals more via `nextPageToken` — this previously wasn't followed, so
 * any query matching more than 100 messages (e.g. `in:sent after:X` on a
 * busy mailbox, easily hit on a first sync scanning the last 30 days)
 * silently dropped everything past the first page. For reply detection
 * that meant sent messages beyond #100 were never matched back to their
 * inbound emails, leaving genuinely-replied emails stuck showing as
 * Pending. Now follows nextPageToken (each page still capped at Gmail's
 * 100-per-request max) until either the API stops returning a token or the
 * accumulated total reaches `maxResults`.
 */
async function listGmailMessageIds(query: string, accessToken: string, maxResults = 500): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(Math.min(100, maxResults - ids.length)));
    listUrl.searchParams.set("includeSpamTrash", "false");
    listUrl.searchParams.set("q", query);
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!listRes.ok) throw new Error(`Failed to list Gmail messages: ${await listRes.text()}`);
    const { messages = [], nextPageToken } = (await listRes.json()) as {
      messages?: { id: string }[];
      nextPageToken?: string;
    };

    ids.push(...messages.map((m) => m.id));
    pageToken = nextPageToken;
  } while (pageToken && ids.length < maxResults);

  return ids;
}

/**
 * Fetches just the threadId/internalDate for a Sent-labeled Gmail message —
 * used exclusively for reply detection (matchGmailReplies), so there's no
 * need to pull the full body/headers the way fetchGmailMessage does for
 * inbound mail.
 */
async function fetchGmailSentMeta(id: string, accessToken: string): Promise<GmailSentMeta | null> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=minimal`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const msg = (await res.json()) as any;
  if (!msg.threadId) return null;
  return {
    threadId: msg.threadId,
    internalDate: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : new Date(),
  };
}

async function fetchGmailMessage(id: string, accessToken: string): Promise<ParsedMessage | null> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const msg = (await res.json()) as any;

  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;

  const labelIds: string[] = msg.labelIds ?? [];
  const fromRaw = headers["from"] ?? "";
  const fromMatch = fromRaw.match(/^(.*?)\s*<(.+?)>$/) ?? [];
  const fromAddress = fromMatch[2]?.trim() || fromRaw;
  const fromName = fromMatch[1]?.trim().replace(/^"|"$/g, "") || null;

  const toRaw = headers["to"] ?? "";
  const toAddresses = toRaw
    .split(",")
    .map((s: string) => (s.match(/<(.+?)>/)?.[1] ?? s).trim())
    .filter(Boolean);

  const { bodyText, bodyHtml } = extractBody(msg.payload);
  const finalBodyText = bodyText || msg.snippet || "";

  const attachmentRefs = extractAttachmentRefs(msg.payload);
  const attachments: ParsedAttachment[] = [];
  for (const ref of attachmentRefs) {
    const content = await fetchGmailAttachment(id, ref.attachmentId, accessToken);
    if (content && content.byteLength <= MAX_ATTACHMENT_BYTES) {
      attachments.push({ filename: ref.filename, mimeType: ref.mimeType, content });
    }
  }

  return {
    gmailMessageId: id,
    threadId: msg.threadId,
    fromAddress,
    fromName,
    toAddresses,
    subject: headers["subject"] || null,
    isRead: !labelIds.includes("UNREAD"),
    internalDate: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : new Date(),
    bodyText: finalBodyText,
    bodyHtml,
    snippet: msg.snippet || finalBodyText.slice(0, 160),
    attachments,
  };
}

/**
 * Syncs new messages for one employee's mail account (Gmail via API, IMAP
 * via imapSync.ts), then runs categorization + priority scoring on each
 * newly-seen email. MANUAL accounts have nothing to pull from a remote
 * server, so this is a no-op for them — manual emails are created directly
 * by POST /api/emails.
 */
export async function syncEmployeeInbox(employeeId: string): Promise<{ synced: number }> {
  const account = await prisma.gmailAccount.findFirst({ where: { employeeId, isActive: true } });
  if (!account || account.status !== "CONNECTED") return { synced: 0 };
  if (account.provider === "MANUAL") return { synced: 0 };

  let parsedMessages: ParsedMessage[] = [];
  // Populated below for GMAIL accounts, used in the reply-detection phase
  // after inbound sync so we don't have to recompute the access token/window.
  let gmailAccessToken: string | null = null;
  let gmailSinceEpochSec = 0;

  if (account.provider === "GMAIL") {
    const accessToken = await getValidAccessToken(employeeId);
    if (!accessToken) return { synced: 0 };
    gmailAccessToken = accessToken;

    gmailSinceEpochSec = account.lastSyncedAt
      ? Math.floor(account.lastSyncedAt.getTime() / 1000)
      : Math.floor((Date.now() - 1000 * 60 * 60 * 24 * 30) / 1000); // first sync: last 30 days

    const messageIds = await listGmailMessageIds(`after:${gmailSinceEpochSec}`, accessToken);

    const BATCH_SIZE = 10;
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      const fetched = await Promise.all(batch.map((id) => fetchGmailMessage(id, accessToken)));
      for (const m of fetched) if (m) parsedMessages.push(m);
    }
  } else {
    // IMAP
    const imapMessages = await fetchImapMessages(account);
    parsedMessages = imapMessages.map((m) => ({
      gmailMessageId: m.imapMessageId,
      threadId: m.threadId,
      fromAddress: m.fromAddress,
      fromName: m.fromName,
      toAddresses: m.toAddresses,
      subject: m.subject,
      isRead: m.isRead,
      internalDate: m.internalDate,
      bodyText: m.bodyText,
      bodyHtml: m.bodyHtml,
      snippet: m.snippet,
      attachments: m.attachments,
    }));
  }

  let synced = 0;

  for (const parsed of parsedMessages) {
    // Dedup: unique constraint on (gmailAccountId, gmailMessageId) means a
    // re-sync (e.g. overlapping window) just no-ops rather than duplicating rows.
    const existing = await prisma.email.findUnique({
      where: { gmailAccountId_gmailMessageId: { gmailAccountId: account.id, gmailMessageId: parsed.gmailMessageId } },
      include: { category: true },
    });
    if (existing) {
      // Self-healing: an email can already exist but still lack a category —
      // either it predates the AI categorization feature (categorizeEmail
      // only ever ran for rows created *after* that feature shipped, never
      // backfilled for the pre-existing backlog), or a past categorization
      // attempt failed transiently and was never retried (fire-and-forget
      // below only logs failures, it doesn't retry them). Catch it up here
      // rather than leaving it uncategorized forever.
      if (!existing.category) {
        categorizeEmail(employeeId, existing.id, existing.bodyText ?? parsed.bodyText).catch((e) =>
          console.error(`[AI] backfill categorize failed for email ${existing.id}:`, e)
        );
      }
      continue;
    }

    const email = await prisma.email.create({
      data: {
        gmailAccountId: account.id,
        gmailMessageId: parsed.gmailMessageId,
        threadId: parsed.threadId,
        fromAddress: parsed.fromAddress,
        fromName: parsed.fromName,
        toAddresses: parsed.toAddresses.length ? JSON.stringify(parsed.toAddresses) : null,
        subject: parsed.subject,
        receivedAt: parsed.internalDate,
        isRead: parsed.isRead,
        bodyText: parsed.bodyText || null,
        bodyHtml: parsed.bodyHtml || null,
        snippet: parsed.snippet || null,
      },
    });
    synced++;

    for (let i = 0; i < parsed.attachments.length; i++) {
      const att = parsed.attachments[i];
      try {
        const storageKey = makeStorageKey(email.id, i, att.filename);
        await writeAttachment(storageKey, att.content, att.mimeType);
        await prisma.attachment.create({
          data: {
            emailId: email.id,
            filename: att.filename,
            mimeType: att.mimeType,
            sizeBytes: att.content.byteLength,
            storageKey,
          },
        });
      } catch (e) {
        // An attachment failing to persist shouldn't fail the whole sync —
        // the email itself is still useful without it.
        console.error(`[attachments] failed to store attachment for email ${email.id}:`, e);
      }
    }

    // Fire-and-forget: categorization/priority shouldn't block the sync
    // loop or fail the whole batch if the LLM provider has a bad moment.
    categorizeEmail(employeeId, email.id, parsed.bodyText).catch((e) =>
      console.error(`[AI] categorize failed for email ${email.id}:`, e)
    );
    scoreEmailPriority(employeeId, email.id, parsed.bodyText).catch((e) =>
      console.error(`[AI] priority scoring failed for email ${email.id}:`, e)
    );
  }

  // Reply detection: look at what this employee sent (Gmail's Sent label,
  // or the IMAP account's Sent/Sent Items folder) and match it back to
  // inbound emails it answered. Candidates are every Email row on this
  // account — not just unreplied ones — since a thread can get more than
  // one reply over time and lastReplyAt should keep moving forward.
  try {
    const candidates: ReplyCandidate[] = await prisma.email.findMany({
      where: { gmailAccountId: account.id },
      select: { id: true, gmailMessageId: true, threadId: true, receivedAt: true },
    });

    let matches: Map<string, Date[]>;

    if (account.provider === "GMAIL" && gmailAccessToken) {
      const sentIds = await listGmailMessageIds(`in:sent after:${gmailSinceEpochSec}`, gmailAccessToken);
      const sentMeta: GmailSentMeta[] = [];
      const BATCH_SIZE = 10;
      for (let i = 0; i < sentIds.length; i += BATCH_SIZE) {
        const batch = sentIds.slice(i, i + BATCH_SIZE);
        const fetched = await Promise.all(batch.map((id) => fetchGmailSentMeta(id, gmailAccessToken!)));
        for (const m of fetched) if (m) sentMeta.push(m);
      }
      matches = matchGmailReplies(sentMeta, candidates);
    } else if (account.provider === "IMAP") {
      const sentMessages = await fetchImapSentMessages(account);
      matches = matchImapReplies(sentMessages, candidates);
    } else {
      matches = new Map();
    }

    for (const [emailId, timestamps] of matches) {
      await recordReply(emailId, timestamps);
    }
  } catch (e) {
    // Reply detection is a "nice to have" layered on top of inbox sync, not
    // a blocker for it — a failure here shouldn't prevent the inbox sync
    // that already ran above from being marked complete.
    console.error(`[replyTracking] failed to detect replies for account ${account.id}:`, e);
  }

  await refreshPendingDurations(account.id);
  await prisma.gmailAccount.update({ where: { id: account.id }, data: { lastSyncedAt: new Date() } });

  return { synced };
}
