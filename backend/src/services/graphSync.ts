/**
 * Microsoft Graph mail fetching for OUTLOOK accounts.
 *
 * Why Graph and not IMAP: Microsoft disabled Basic Auth for Outlook.com, and
 * personal (consumer) Microsoft accounts are NOT eligible for OAuth over
 * IMAP — Microsoft's own guidance is that OAuth is unsupported for
 * POP/IMAP on Outlook.com, and requesting the Exchange IMAP scope for a
 * consumer account comes back as access_denied. Graph, by contrast, fully
 * supports personal accounts with the delegated Mail.Read scope and needs no
 * Exchange Online service principal in the tenant.
 *
 * This mirrors the Gmail-API path in emailSync.ts rather than the IMAP one:
 * messages are listed newest-first, fetched one page at a time, and handed
 * back through a callback so each message's memory is released before the
 * next is processed.
 */
import { htmlToPlainText } from "../lib/htmlToText";
import { isPromotionalEmail } from "./promoDetector";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface ParsedGraphAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface ParsedGraphMessage {
  graphMessageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  isRead: boolean;
  internalDate: Date;
  bodyText: string;
  bodyHtml: string;
  snippet: string;
  attachments: ParsedGraphAttachment[];
  isPromotional: boolean;
}

export interface GraphAttachmentBudget {
  remainingBytes: number;
}

/** Matches the Gmail path's per-file ceiling — one Buffer this size is decoded
 *  off-heap during a fetch, so on a small instance it has to stay modest. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string | null;
  bodyPreview?: string;
  isRead?: boolean;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name: string; value: string }[];
}

async function graphGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Microsoft Graph request failed (${res.status}): ${body}`);
    // 401 means the access token is bad/expired — the caller refreshes and
    // retries rather than treating it as a permanent failure.
    (err as any).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

function addresses(list: GraphRecipient[] | undefined): string[] {
  if (!list) return [];
  return list.map((r) => r.emailAddress?.address).filter((a): a is string => !!a);
}

/** Case-insensitive lookup over Graph's internetMessageHeaders array. */
function header(msg: GraphMessage, name: string): string | null {
  const target = name.toLowerCase();
  const hit = msg.internetMessageHeaders?.find((h) => h.name?.toLowerCase() === target);
  return hit?.value ?? null;
}

async function fetchAttachments(
  messageId: string,
  accessToken: string,
  budget: GraphAttachmentBudget
): Promise<ParsedGraphAttachment[]> {
  // Only fileAttachments carry bytes inline (contentBytes). Item attachments
  // (an attached mail/event) and reference attachments (a OneDrive link) have
  // no bytes to store, so they're skipped rather than mishandled.
  type GraphAttachment = {
    "@odata.type"?: string;
    id: string;
    name?: string;
    contentType?: string;
    size?: number;
    contentBytes?: string;
  };

  const out: ParsedGraphAttachment[] = [];
  try {
    const data = await graphGet<{ value: GraphAttachment[] }>(
      `${GRAPH_BASE}/me/messages/${messageId}/attachments`,
      accessToken
    );
    for (const att of data.value ?? []) {
      if (!att.contentBytes) continue; // not an inline file attachment
      const size = att.size ?? 0;
      if (size > MAX_ATTACHMENT_BYTES) continue;
      if (size > budget.remainingBytes) continue; // budget spent; email still syncs
      const content = Buffer.from(att.contentBytes, "base64");
      if (content.byteLength > MAX_ATTACHMENT_BYTES) continue;
      budget.remainingBytes -= content.byteLength;
      out.push({
        filename: att.name || "attachment",
        mimeType: att.contentType || "application/octet-stream",
        content,
      });
    }
  } catch (e) {
    // An attachment failure must never lose the email itself.
    console.error(`[graph] failed to fetch attachments for message ${messageId}:`, e);
  }
  return out;
}

function toParsed(msg: GraphMessage, attachments: ParsedGraphAttachment[]): ParsedGraphMessage {
  const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html";
  const rawBody = msg.body?.content ?? "";
  const bodyHtml = isHtml ? rawBody : "";
  const bodyText = isHtml ? htmlToPlainText(rawBody) : rawBody;

  const fromRec = msg.from ?? msg.sender;

  return {
    graphMessageId: msg.id,
    // Graph's conversationId is the direct analogue of Gmail's threadId.
    // Falling back to the message id keeps a message its own thread rather
    // than silently grouping unrelated mail under an empty key.
    threadId: msg.conversationId || msg.id,
    fromAddress: fromRec?.emailAddress?.address ?? "unknown@unknown",
    fromName: fromRec?.emailAddress?.name ?? null,
    toAddresses: addresses(msg.toRecipients),
    ccAddresses: addresses(msg.ccRecipients),
    subject: msg.subject ?? null,
    isRead: msg.isRead ?? false,
    internalDate: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
    bodyText,
    bodyHtml,
    snippet: (msg.bodyPreview ?? bodyText).slice(0, 160),
    attachments,
    // Graph exposes no Gmail-style category labels, so this uses the same
    // deterministic bulk-mail header signals the IMAP path relies on.
    isPromotional: isPromotionalEmail({
      listUnsubscribe: header(msg, "List-Unsubscribe"),
      precedence: header(msg, "Precedence"),
      autoSubmitted: header(msg, "Auto-Submitted"),
      bodyText,
      bodyHtml,
    }),
  };
}

/**
 * Streams messages from a folder, newest first, invoking `onMessage` for each
 * so the caller can persist and discard it before the next arrives.
 *
 * @param since   only messages received at/after this instant
 * @param max     hard cap on messages pulled this run
 * @param folder  "inbox" or "sentitems"
 */
export async function fetchGraphMessagesStreaming(
  accessToken: string,
  opts: { since: Date; max: number; folder?: "inbox" | "sentitems"; withAttachments?: boolean },
  onMessage: (m: ParsedGraphMessage) => Promise<void>
): Promise<number> {
  const folder = opts.folder ?? "inbox";
  const withAttachments = opts.withAttachments ?? true;
  const budget: GraphAttachmentBudget = { remainingBytes: 24 * 1024 * 1024 };

  const select = [
    "id",
    "conversationId",
    "subject",
    "bodyPreview",
    "isRead",
    "receivedDateTime",
    "hasAttachments",
    "from",
    "sender",
    "toRecipients",
    "ccRecipients",
    "body",
    "internetMessageHeaders",
  ].join(",");

  // Page size is deliberately small: each message carries a full body, so a
  // large page would hold many bodies in memory at once.
  const pageSize = Math.min(25, opts.max);
  let url =
    `${GRAPH_BASE}/me/mailFolders/${folder}/messages` +
    `?$select=${select}` +
    `&$filter=receivedDateTime ge ${opts.since.toISOString()}` +
    `&$orderby=receivedDateTime desc` +
    `&$top=${pageSize}`;

  let processed = 0;
  while (url && processed < opts.max) {
    const page = await graphGet<{ value: GraphMessage[]; "@odata.nextLink"?: string }>(url, accessToken);
    for (const msg of page.value ?? []) {
      if (processed >= opts.max) break;
      const attachments =
        withAttachments && msg.hasAttachments ? await fetchAttachments(msg.id, accessToken, budget) : [];
      await onMessage(toParsed(msg, attachments));
      processed++;
    }
    url = page["@odata.nextLink"] ?? "";
  }

  return processed;
}

export interface GraphReplyAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64, no data: prefix
}

/**
 * Replies to a message using Graph's own reply endpoint rather than composing
 * a fresh mail. Graph then sets In-Reply-To/References and keeps the reply in
 * the original conversation automatically, which is what makes the app's
 * reply-detection (matched on conversationId) line up afterwards.
 *
 * Requires the Mail.Send delegated scope — an account connected before that
 * scope was requested must be reconnected before this will succeed.
 */
export async function sendGraphReply(
  accessToken: string,
  messageId: string,
  body: string,
  attachments: GraphReplyAttachment[] = []
): Promise<void> {
  const payload: Record<string, unknown> = {
    message: {
      body: { contentType: "Text", content: body },
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.filename,
              contentType: a.mimeType,
              contentBytes: a.data,
            })),
          }
        : {}),
    },
  };

  const res = await fetch(`${GRAPH_BASE}/me/messages/${messageId}/reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Graph returns 202 Accepted with an empty body on success.
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403) {
      throw new Error(
        "Outlook denied the send request. Reconnect the Outlook account to grant send permission, then try again."
      );
    }
    throw new Error(`Failed to send reply via Outlook (${res.status}): ${text}`);
  }
}

/** Sent-folder metadata used for reply detection, mirroring the Gmail path. */
export interface GraphSentMeta {
  threadId: string;
  sentAt: Date;
  inReplyTo: string | null;
}

export async function fetchGraphSentMeta(
  accessToken: string,
  since: Date,
  max = 100
): Promise<GraphSentMeta[]> {
  const out: GraphSentMeta[] = [];
  const url =
    `${GRAPH_BASE}/me/mailFolders/sentitems/messages` +
    `?$select=id,conversationId,sentDateTime,internetMessageHeaders` +
    `&$filter=sentDateTime ge ${since.toISOString()}` +
    `&$orderby=sentDateTime desc&$top=${Math.min(50, max)}`;

  try {
    const page = await graphGet<{
      value: (GraphMessage & { sentDateTime?: string })[];
    }>(url, accessToken);
    for (const m of page.value ?? []) {
      out.push({
        threadId: m.conversationId || m.id,
        sentAt: m.sentDateTime ? new Date(m.sentDateTime) : new Date(),
        inReplyTo: header(m, "In-Reply-To"),
      });
    }
  } catch (e) {
    console.error("[graph] failed to fetch sent messages for reply detection:", e);
  }
  return out;
}
