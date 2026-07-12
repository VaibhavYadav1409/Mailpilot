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

/**
 * AI categorization — runs automatically right after sync so the inbox is
 * pre-labeled before the employee opens it.
 */
export async function categorizeEmail(employeeId: string, emailId: string, threadContent: string) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an email assistant. Classify the email into exactly one of these categories: ${CATEGORY_TAXONOMY.join(", ")}. Respond ONLY with valid JSON: {"label": "<one of the categories exactly as written>", "confidence": <number 0-1>}`,
      },
      { role: "user", content: `Classify this email thread:\n\n${threadContent}` },
    ],
    responseFormat: { type: "json_object" },
  });

  let label: string = "Other";
  let confidence = 0.5;
  try {
    const parsed = JSON.parse(response.choices[0]?.message.content ?? "{}");
    if (CATEGORY_TAXONOMY.includes(parsed.label)) label = parsed.label;
    confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5));
  } catch {
    // Fall back to "Other" / 0.5 rather than throwing — a bad categorization
    // shouldn't block the sync of the email itself.
  }

  await prisma.emailCategory.upsert({
    where: { emailId },
    create: { emailId, label, source: "AI", confidence },
    update: { label, source: "AI", confidence },
  });

  await logAIAction(employeeId, emailId, "CATEGORIZE");
  return { label, confidence };
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
      { role: "user", content: `Analyze this email thread priority:\n\n${threadContent}` },
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
      { role: "user", content: `Summarize this email thread:\n\n${threadContent}` },
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
        content: `Generate a suggested reply to the [ LATEST MESSAGE ] in this thread. Reply as the person who received it:\n\n${threadContent}`,
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
