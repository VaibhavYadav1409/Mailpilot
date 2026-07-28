import { prisma } from "../lib/db";
import { invokeLLM } from "../lib/llm";

const CATEGORY_TAXONOMY = [
  "Support Request",
  "Billing",
  "Sales Inquiry",
  "Internal",
  "Spam/Promotional",
  "Urgent",
  "Other",
] as const;

/**
 * Hard cap on how much email text is sent to the LLM in one call.
 *
 * Groq's free tier enforces a tokens-per-minute ceiling (12,000 on
 * `llama-3.3-70b-versatile`). Email bodies were previously passed through
 * whole, which caused two distinct failures observed in production:
 *
 *  - A single long email (marketing HTML, a quoted thread, a newsletter)
 *    requested 21,306 tokens and got **HTTP 413 Payload Too Large** — larger
 *    than the entire per-minute allowance, so it could never succeed no
 *    matter how long you waited or how often you retried. 413 is not a
 *    rate-limit error, so neither the retry logic nor the circuit breaker
 *    helped; it was a permanent, silent failure for that email.
 *  - Ordinary emails at ~7,800 tokens each meant barely one call per minute
 *    fit in the budget, so concurrent calls spent most of their time
 *    tripping 429s.
 *
 * ~8,000 characters is roughly 2,000 tokens, which keeps any single call well
 * inside the budget and leaves room for several per minute. Truncating costs
 * nothing for these tasks: whether an email needs a reply, what it's about,
 * and how urgent it is are all established in its opening — not in the
 * fifteenth quoted signature block.
 */
const MAX_LLM_CONTENT_CHARS = 8_000;

export function clampThreadContent(content: string): string {
  if (content.length <= MAX_LLM_CONTENT_CHARS) return content;
  return content.slice(0, MAX_LLM_CONTENT_CHARS) + "\n\n[... truncated for length ...]";
}

async function logAIAction(employeeId: string, emailId: string, actionType: string) {
  return prisma.aIAction.create({ data: { employeeId, emailId, actionType } });
}

/** Latest AIAction id per actionType for an email, so the frontend can call recordAISuggestionOutcome without re-fetching. Returns null for types never generated. */
export async function latestActionIds(emailId: string) {
  const actions = await prisma.aIAction.findMany({
    where: { emailId, actionType: { in: ["SUMMARY", "PRIORITY_SCORE", "SUGGEST_REPLY"] } },
    orderBy: { createdAt: "desc" },
  });
  const byType: Record<string, string> = {};
  for (const a of actions) {
    if (!(a.actionType in byType)) byType[a.actionType] = a.id;
  }
  return {
    summaryActionId: byType["SUMMARY"] ?? null,
    priorityActionId: byType["PRIORITY_SCORE"] ?? null,
    suggestedReplyActionId: byType["SUGGEST_REPLY"] ?? null,
  };
}

// Normalized (lowercased, trimmed) taxonomy string -> canonical label, so a
// model response of "promotional", "Spam / Promotional", or "SPAM/PROMOTIONAL"
// still resolves correctly instead of silently falling back to "Other". The
// exact-string match this replaced meant any deviation in the model's casing
// or spacing left genuinely promotional mail uncategorized — invisible to
// the employee-app's "hide promotional from All" filter, since that filter
// only strips emails already labeled exactly "Spam/Promotional".
const NORMALIZED_TAXONOMY: Record<string, (typeof CATEGORY_TAXONOMY)[number]> = {};
for (const label of CATEGORY_TAXONOMY) {
  NORMALIZED_TAXONOMY[label.toLowerCase().trim()] = label;
}
// A few common ways a model might phrase the promotional category without
// matching the canonical string at all.
for (const alias of ["promotional", "promotions", "spam", "spam / promotional", "marketing", "newsletter"]) {
  NORMALIZED_TAXONOMY[alias] = "Spam/Promotional";
}

function resolveCategoryLabel(raw: unknown): (typeof CATEGORY_TAXONOMY)[number] {
  if (typeof raw !== "string") return "Other";
  const normalized = raw.toLowerCase().trim();
  return NORMALIZED_TAXONOMY[normalized] ?? "Other";
}

// ---------------------------------------------------------------------------
// Reply-worthiness
// ---------------------------------------------------------------------------

/**
 * How an email relates to the recipient's obligation to respond. Only
 * NEEDS_REPLY counts toward "Unreplied"/"Pending" in either app.
 */
export const REPLY_CLASSES = ["NEEDS_REPLY", "ACKNOWLEDGMENT", "INFORMATIONAL", "AUTOMATED"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

// Same defensive normalization approach as NORMALIZED_TAXONOMY above: the
// model will not always echo the enum verbatim, and a near-miss must not
// silently degrade into the wrong bucket. Anything unrecognized falls back to
// NEEDS_REPLY, never to a no-reply class — see resolveReplyClass.
const NORMALIZED_REPLY_CLASSES: Record<string, ReplyClass> = {
  needs_reply: "NEEDS_REPLY",
  "needs reply": "NEEDS_REPLY",
  needsreply: "NEEDS_REPLY",
  reply: "NEEDS_REPLY",
  actionable: "NEEDS_REPLY",
  acknowledgment: "ACKNOWLEDGMENT",
  acknowledgement: "ACKNOWLEDGMENT",
  ack: "ACKNOWLEDGMENT",
  "thank you": "ACKNOWLEDGMENT",
  thanks: "ACKNOWLEDGMENT",
  informational: "INFORMATIONAL",
  informative: "INFORMATIONAL",
  info: "INFORMATIONAL",
  fyi: "INFORMATIONAL",
  announcement: "INFORMATIONAL",
  automated: "AUTOMATED",
  automatic: "AUTOMATED",
  notification: "AUTOMATED",
  "no-reply": "AUTOMATED",
  noreply: "AUTOMATED",
};

/**
 * Resolves the model's raw reply-class string.
 *
 * Unrecognized input resolves to NEEDS_REPLY rather than to any no-reply
 * class. This asymmetry is deliberate and is the whole safety property of the
 * feature: a garbled response must never be the reason a real customer email
 * disappears from an employee's Unreplied list or an admin's Pending count.
 */
export function resolveReplyClass(raw: unknown): ReplyClass {
  if (typeof raw !== "string") return "NEEDS_REPLY";
  const normalized = raw.toLowerCase().trim().replace(/\s+/g, " ");
  if ((REPLY_CLASSES as readonly string[]).includes(normalized.toUpperCase())) {
    return normalized.toUpperCase() as ReplyClass;
  }
  return NORMALIZED_REPLY_CLASSES[normalized] ?? "NEEDS_REPLY";
}

const REPLY_CLASS_GUIDANCE = `Also decide whether the email genuinely warrants a written reply from the recipient, and set "replyClass" to exactly one of:
- "NEEDS_REPLY": asks a question, makes a request, requires a decision, proposes a time, reports a problem, or otherwise leaves the sender waiting on the recipient.
- "ACKNOWLEDGMENT": closes a loop rather than opening one — "thanks", "noted", "received", "sounds good", "will do", a confirmation that something was done. No new question is asked.
- "INFORMATIONAL": shares information for awareness only — status updates, FYIs, announcements, meeting notes, reports, someone copied in for visibility. Nothing is asked of the recipient.
- "AUTOMATED": machine-generated — receipts, invoices, delivery/CI/monitoring notifications, calendar invites, newsletters, no-reply senders.
Judge only by whether a response is actually expected. If a message both shares information AND asks something, it is "NEEDS_REPLY". If you are uncertain, choose "NEEDS_REPLY".`;

/**
 * Deterministically marks an email as not needing a reply, without consulting
 * the LLM. Used for mail whose nature is already settled by hard signals —
 * currently bulk/promotional detection (see promoDetector.ts), which runs on
 * headers and Gmail labels and is strictly more reliable here than the model.
 */
export async function markNoReplyNeeded(emailId: string, replyClass: ReplyClass = "AUTOMATED") {
  await prisma.email.update({
    where: { id: emailId },
    data: { requiresReply: false, replyClassification: replyClass, replyClassifiedAt: new Date() },
  });
}

/**
 * AI categorization — runs automatically right after sync so the inbox is
 * pre-labeled before the employee opens it.
 *
 * This single call also decides reply-worthiness (`replyClass`). Folding it
 * into the existing categorization request rather than issuing a second one
 * is deliberate: sync already fans out one LLM call per new email per feature,
 * and adding another round trip per message is exactly the pattern that has
 * repeatedly tripped the Groq rate limiter and the memory ceiling on large
 * syncs. The two judgements need identical context, so they share a call.
 */
export async function categorizeEmail(employeeId: string, emailId: string, threadContent: string) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          `You are an email assistant. Classify the email into exactly one of these categories: ${CATEGORY_TAXONOMY.join(", ")}.\n\n` +
          `${REPLY_CLASS_GUIDANCE}\n\n` +
          `Respond ONLY with valid JSON: {"label": "<one of the categories exactly as written>", "confidence": <number 0-1>, "replyClass": "<NEEDS_REPLY|ACKNOWLEDGMENT|INFORMATIONAL|AUTOMATED>"}`,
      },
      { role: "user", content: `Classify this email thread:\n\n${clampThreadContent(threadContent)}` },
    ],
    responseFormat: { type: "json_object" },
  });

  let label: string = "Other";
  let confidence = 0.5;
  // Defaults if parsing fails entirely: treat the email as needing a reply.
  // Same reasoning as resolveReplyClass — an LLM/parse failure must not be
  // what removes an email from someone's Pending list.
  let replyClass: ReplyClass = "NEEDS_REPLY";
  try {
    const parsed = JSON.parse(response.choices[0]?.message.content ?? "{}");
    label = resolveCategoryLabel(parsed.label);
    confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5));
    replyClass = resolveReplyClass(parsed.replyClass);
  } catch {
    // Fall back to "Other" / 0.5 rather than throwing — a bad categorization
    // shouldn't block the sync of the email itself.
  }

  // Promotional mail is settled by headers, not by the model — if the
  // heuristic already filed this as promotional, don't let a stray
  // "NEEDS_REPLY" from the LLM drag a newsletter back into Pending.
  if (label === "Spam/Promotional") replyClass = "AUTOMATED";

  await prisma.emailCategory.upsert({
    where: { emailId },
    create: { emailId, label, source: "AI", confidence },
    update: { label, source: "AI", confidence },
  });

  await prisma.email.update({
    where: { id: emailId },
    data: {
      requiresReply: replyClass === "NEEDS_REPLY",
      replyClassification: replyClass,
      replyClassifiedAt: new Date(),
    },
  });

  await logAIAction(employeeId, emailId, "CATEGORIZE");
  return { label, confidence, replyClass, requiresReply: replyClass === "NEEDS_REPLY" };
}

/** Priority score 1-10. Persisted onto the Email row so the client can read it back without regenerating. */
export async function scoreEmailPriority(employeeId: string, emailId: string, threadContent: string) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          'You are an email assistant. Assign a priority score 1-10 (1=low, 10=urgent) based on the full email thread. Respond ONLY with valid JSON: {"score": <number>, "rationale": "<string>"}',
      },
      { role: "user", content: `Analyze this email thread priority:\n\n${clampThreadContent(threadContent)}` },
    ],
    responseFormat: { type: "json_object" },
  });

  let score = 5;
  let rationale = "Unable to analyze priority";
  try {
    const parsed = JSON.parse(response.choices[0]?.message.content ?? "{}");
    score = Math.max(1, Math.min(10, parsed.score ?? 5));
    rationale = parsed.rationale ?? rationale;
  } catch {
    // keep defaults
  }

  await prisma.email.update({
    where: { id: emailId },
    data: { aiPriorityScore: score, aiPriorityRationale: rationale },
  });
  const action = await logAIAction(employeeId, emailId, "PRIORITY_SCORE");
  return { priorityScore: score, priorityRationale: rationale, actionId: action.id };
}

/** 2-3 sentence thread summary. Persisted onto the Email row. */
export async function summarizeEmailThread(employeeId: string, emailId: string, threadContent: string) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are an email assistant. Generate a concise 2-3 sentence summary of the email thread. Focus on the main points, any action items, and the current state of the conversation.",
      },
      { role: "user", content: `Summarize this email thread:\n\n${clampThreadContent(threadContent)}` },
    ],
  });

  const summary = response.choices[0]?.message.content || "Unable to generate summary";
  await prisma.email.update({ where: { id: emailId }, data: { aiSummary: summary } });
  const action = await logAIAction(employeeId, emailId, "SUMMARY");
  return { summary, actionId: action.id };
}

/** Suggested reply. Persisted onto the Email row. */
export async function suggestEmailReply(employeeId: string, emailId: string, threadContent: string) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are an email assistant. The user has RECEIVED the email thread shown below and wants to write a reply to it. " +
          "Write a professional, concise reply (2-3 sentences) from the perspective of the RECIPIENT of the latest message — " +
          "base the reply on what is actually being asked or communicated in the latest message and the conversation history.",
      },
      {
        role: "user",
        content: `Generate a suggested reply to the [ LATEST MESSAGE ] in this thread. Reply as the person who received it:\n\n${clampThreadContent(threadContent)}`,
      },
    ],
  });

  const suggestedReply = response.choices[0]?.message.content || "Unable to generate reply";
  await prisma.email.update({ where: { id: emailId }, data: { aiSuggestedReply: suggestedReply } });
  const action = await logAIAction(employeeId, emailId, "SUGGEST_REPLY");
  return { suggestedReply, actionId: action.id };
}

/** Records whether the employee accepted an AI suggestion as-is, or edited/rejected it — feeds DailyAnalytics.aiAcceptanceRate. */
export async function recordAISuggestionOutcome(aiActionId: string, accepted: boolean) {
  await prisma.aIAction.update({ where: { id: aiActionId }, data: { accepted } });
}
