import { prisma } from "../lib/db";
import { getValidAccessToken } from "./gmailAccountService";
import { fetchImapMessages, fetchImapMessagesStreaming, fetchImapSentMessages } from "./imapSync";
import { categorizeEmail, scoreEmailPriority } from "./aiPipeline";
import { isPromotionalEmail, PROMOTIONAL_LABEL, headerValue } from "./promoDetector";
import { isGroqCoolingDown } from "../lib/llm";
import { makeStorageKey, writeAttachment } from "../lib/attachmentStorage";
import { matchGmailReplies, matchImapReplies, recordReply, refreshPendingDurations, type ReplyCandidate } from "./replyTracking";
import { htmlToPlainText } from "../lib/htmlToText";
import { createLimiter } from "../lib/concurrencyLimit";

// categorizeEmail/scoreEmailPriority are fired per-message without being
// awaited (see persistParsedMessage below) so the sync loop itself isn't
// slowed down by LLM latency. Left completely unbounded, a first sync of a
// few hundred messages fired that many concurrent Groq requests at once —
// each holding open sockets, request/response buffers, and a Prisma query —
// which is what was still exceeding Render's 512MB limit even after the
// streaming persistence fix. Capping shared concurrency here queues the
// excess instead of firing it all at once, without changing the
// fire-and-forget call sites themselves.
const aiCallLimiter = createLimiter(4);

// How far back reply detection looks for inbound emails a newly-sent message
// might be answering. Bounds the per-sync candidate scan so it doesn't grow
// with total mailbox age. 120 days comfortably covers real reply latencies.
const REPLY_CANDIDATE_WINDOW_DAYS = 120;

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

// On top of the per-file cap above, cap total attachment bytes held in
// memory across one whole syncEmployeeInbox() run. Without this, a 30-day
// first sync with several attachment-heavy messages could still add up to
// hundreds of MB even with a small BATCH_SIZE, since the per-file cap alone
// doesn't bound the sum across a sync. Once the budget is exhausted, further
// attachments in this sync are skipped (the email itself is still synced
// and persisted normally) rather than fetched and held in memory.
const ATTACHMENT_SYNC_BUDGET_BYTES = 80 * 1024 * 1024; // 80MB per sync run

interface AttachmentBudget {
  remainingBytes: number;
}

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
  // Deterministic promotional/bulk flag computed at parse time from Gmail
  // labels or bulk-mail headers (see promoDetector.ts). When true, the email
  // is labeled "Spam/Promotional" directly, bypassing the flaky LLM path.
  isPromotional?: boolean;
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

async function fetchGmailMessage(id: string, accessToken: string, attachmentBudget: AttachmentBudget): Promise<ParsedMessage | null> {
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
    if (attachmentBudget.remainingBytes <= 0) {
      console.warn(`[sync] attachment sync budget exhausted, skipping "${ref.filename}" on message ${id}`);
      break;
    }
    const content = await fetchGmailAttachment(id, ref.attachmentId, accessToken);
    if (content && content.byteLength <= MAX_ATTACHMENT_BYTES) {
      attachments.push({ filename: ref.filename, mimeType: ref.mimeType, content });
      attachmentBudget.remainingBytes -= content.byteLength;
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
    isPromotional: isPromotionalEmail({
      gmailLabelIds: labelIds,
      listUnsubscribe: headers["list-unsubscribe"] ?? null,
      precedence: headers["precedence"] ?? null,
      autoSubmitted: headers["auto-submitted"] ?? null,
      bodyText: finalBodyText,
      bodyHtml,
    }),
  };
}

/**
 * Persists one already-parsed message: dedup check, row create, attachment
 * storage, and kicking off AI categorization/priority scoring. Pulled out
 * of the main sync loop so both the Gmail and IMAP paths can call it
 * immediately per-message instead of collecting a full parsedMessages[]
 * array first — holding up to hundreds of full bodies/HTML/attachment
 * buffers (25MB each) in memory at once was what exceeded Render's 512MB
 * limit on a fresh sync. Returns true if a new row was created.
 */
/**
 * Directly labels an email as promotional, no LLM involved. Used when a hard
 * signal (Gmail category label, List-Unsubscribe header, etc.) already told us
 * the message is bulk/marketing mail. Idempotent via upsert.
 */
async function labelPromotional(emailId: string): Promise<void> {
  try {
    await prisma.emailCategory.upsert({
      where: { emailId },
      create: { emailId, label: PROMOTIONAL_LABEL, source: "HEURISTIC", confidence: 1 },
      update: { label: PROMOTIONAL_LABEL, source: "HEURISTIC", confidence: 1 },
    });
  } catch (e) {
    console.error(`[promo] failed to label email ${emailId} as promotional:`, e);
  }
}

async function persistParsedMessage(employeeId: string, accountId: string, parsed: ParsedMessage): Promise<boolean> {
  // Dedup: unique constraint on (gmailAccountId, gmailMessageId) means a
  // re-sync (e.g. overlapping window) just no-ops rather than duplicating rows.
  const existing = await prisma.email.findUnique({
    where: { gmailAccountId_gmailMessageId: { gmailAccountId: accountId, gmailMessageId: parsed.gmailMessageId } },
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
    if (parsed.isPromotional) {
      // Deterministic promo signal (Gmail label / List-Unsubscribe header).
      // Ensure it's filed under Promotions even if a prior LLM pass left it
      // blank OR mislabeled it as something else — but never override a label
      // a human set manually. This is what lets a re-sync retroactively fix
      // the existing inbox once this code is deployed.
      if (existing.category?.label !== PROMOTIONAL_LABEL && existing.category?.source !== "MANUAL") {
        await labelPromotional(existing.id);
      }
    } else if (!existing.category && !isGroqCoolingDown()) {
      aiCallLimiter(() => categorizeEmail(employeeId, existing.id, existing.bodyText ?? parsed.bodyText)).catch((e) =>
        console.error(`[AI] backfill categorize failed for email ${existing.id}:`, e)
      );
    }
    return false;
  }

  const email = await prisma.email.create({
    data: {
      gmailAccountId: accountId,
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

  // Promotional mail is decided by hard signals (Gmail labels / bulk-mail
  // headers), not the LLM — so it lands in "Promotions" reliably even when
  // the LLM is rate-limited or wrong. Everything else goes to the LLM
  // categorizer as before.
  if (parsed.isPromotional) {
    await labelPromotional(email.id);
  } else if (!isGroqCoolingDown()) {
    // Fire-and-forget: categorization shouldn't block the sync loop or fail
    // the whole batch if the LLM provider has a bad moment. Skipped entirely
    // while the Groq breaker is open so a big sync doesn't queue hundreds of
    // doomed, memory-holding calls against an exhausted quota (the cause of a
    // prior Render OOM). Uncategorized rows are caught on a later sync.
    aiCallLimiter(() => categorizeEmail(employeeId, email.id, parsed.bodyText)).catch((e) =>
      console.error(`[AI] categorize failed for email ${email.id}:`, e)
    );
  }
  if (!isGroqCoolingDown()) {
    aiCallLimiter(() => scoreEmailPriority(employeeId, email.id, parsed.bodyText)).catch((e) =>
      console.error(`[AI] priority scoring failed for email ${email.id}:`, e)
    );
  }

  return true;
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

  // Populated below for GMAIL accounts, used in the reply-detection phase
  // after inbound sync so we don't have to recompute the access token/window.
  let gmailAccessToken: string | null = null;
  let gmailSinceEpochSec = 0;
  let synced = 0;

  if (account.provider === "GMAIL") {
    const accessToken = await getValidAccessToken(employeeId);
    if (!accessToken) return { synced: 0 };
    gmailAccessToken = accessToken;

    gmailSinceEpochSec = account.lastSyncedAt
      ? Math.floor(account.lastSyncedAt.getTime() / 1000)
      : Math.floor((Date.now() - 1000 * 60 * 60 * 24 * 30) / 1000); // first sync: last 30 days

    const messageIds = await listGmailMessageIds(`after:${gmailSinceEpochSec}`, accessToken);

    // Fetch a small batch concurrently (bounded memory: at most BATCH_SIZE
    // full messages in flight at once), then persist and drop each one
    // immediately rather than accumulating every batch into one array —
    // on a 500-message first sync that array previously held every body,
    // HTML part, and attachment buffer simultaneously.
    //
    // BATCH_SIZE was 10, which combined with per-message attachment buffers
    // (up to 25MB each, uncapped in aggregate) was enough on its own to
    // exceed Render's 512MB limit and get the process OOM-killed mid-sync
    // (surfacing to the client as a 502, since Render's proxy returns 502
    // when the backend dies rather than a 504 timeout). Dropped to 3, and
    // combined with the attachmentBudget below (shared across the whole
    // sync, not just one batch) to bound total memory, not just per-batch.
    const BATCH_SIZE = 3;
    const attachmentBudget: AttachmentBudget = { remainingBytes: ATTACHMENT_SYNC_BUDGET_BYTES };
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      const fetched = await Promise.all(batch.map((id) => fetchGmailMessage(id, accessToken, attachmentBudget)));
      for (const m of fetched) {
        if (!m) continue;
        if (await persistParsedMessage(employeeId, account.id, m)) synced++;
      }
      const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const attachMb = Math.round((ATTACHMENT_SYNC_BUDGET_BYTES - attachmentBudget.remainingBytes) / 1024 / 1024);
      console.log(
        `[sync] account ${account.id}: batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(messageIds.length / BATCH_SIZE)}, rss=${rssMb}MB, attachmentBudgetUsed=${attachMb}MB`
      );
    }
  } else {
    // IMAP: stream messages one at a time straight into persistParsedMessage
    // so each message's memory is freed before the next is fetched.
    await fetchImapMessagesStreaming(account, async (m) => {
      const parsed: ParsedMessage = {
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
        isPromotional: m.isPromotional,
      };
      if (await persistParsedMessage(employeeId, account.id, parsed)) synced++;
    });
  }

  // Reply detection: look at what this employee sent (Gmail's Sent label,
  // or the IMAP account's Sent/Sent Items folder) and match it back to
  // inbound emails it answered. Candidates include already-replied ones too
  // (not just unreplied), since a thread can get more than one reply over
  // time and lastReplyAt should keep moving forward.
  //
  // Bounded to a recent window instead of the entire account: the sent
  // messages we match against are themselves only pulled from the current
  // sync window, and a reply almost always answers a still-active thread.
  // Scanning every email ever on the account grew unbounded with mailbox age
  // for no practical gain; REPLY_CANDIDATE_WINDOW_DAYS is generous enough to
  // catch replies to threads that went quiet for a while.
  const candidateSince = new Date(Date.now() - REPLY_CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  try {
    const candidates: ReplyCandidate[] = await prisma.email.findMany({
      where: { gmailAccountId: account.id, receivedAt: { gte: candidateSince } },
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
