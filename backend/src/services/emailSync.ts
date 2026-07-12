import { prisma } from "../lib/db";
import { getValidAccessToken } from "./gmailAccountService";
import { fetchImapMessages } from "./imapSync";
import { categorizeEmail, scoreEmailPriority } from "./aiPipeline";
import { makeStorageKey, writeAttachment } from "../lib/attachmentStorage";

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
  snippet: string;
  attachments: ParsedAttachment[];
}

function extractBody(payload: any): string {
  let bodyText = "";
  const walk = (part: any) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      bodyText += Buffer.from(part.body.data, "base64").toString("utf-8");
    }
    for (const sub of part.parts ?? []) walk(sub);
  };
  walk(payload);
  return bodyText;
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

  const bodyText = extractBody(msg.payload) || msg.snippet || "";

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
    bodyText,
    snippet: msg.snippet || bodyText.slice(0, 160),
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
  const account = await prisma.gmailAccount.findUnique({ where: { employeeId } });
  if (!account || account.status !== "CONNECTED") return { synced: 0 };
  if (account.provider === "MANUAL") return { synced: 0 };

  let parsedMessages: ParsedMessage[] = [];

  if (account.provider === "GMAIL") {
    const accessToken = await getValidAccessToken(employeeId);
    if (!accessToken) return { synced: 0 };

    const sinceEpochSec = account.lastSyncedAt
      ? Math.floor(account.lastSyncedAt.getTime() / 1000)
      : Math.floor((Date.now() - 1000 * 60 * 60 * 24 * 30) / 1000); // first sync: last 30 days

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", "100");
    listUrl.searchParams.set("includeSpamTrash", "false");
    listUrl.searchParams.set("q", `after:${sinceEpochSec}`);

    const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!listRes.ok) throw new Error(`Failed to list Gmail messages: ${await listRes.text()}`);
    const { messages = [] } = (await listRes.json()) as { messages?: { id: string }[] };

    const BATCH_SIZE = 10;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      const fetched = await Promise.all(batch.map(({ id }) => fetchGmailMessage(id, accessToken)));
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
    });
    if (existing) continue;

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

  await prisma.gmailAccount.update({ where: { id: account.id }, data: { lastSyncedAt: new Date() } });

  return { synced };
}
