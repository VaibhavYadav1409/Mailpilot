import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { prisma } from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { syncEmployeeInbox } from "../services/emailSync";
import {
  summarizeEmailThread,
  suggestEmailReply,
  scoreEmailPriority,
  recordAISuggestionOutcome,
  latestActionIds,
} from "../services/aiPipeline";
import { sendReply } from "../services/emailActions";
import { getOrCreateManualAccount } from "../services/imapAccountService";
import { readAttachment } from "../lib/attachmentStorage";

export const emailsRouter = Router();

/**
 * Every route below scopes to `req.user!.employeeId` directly rather than
 * accepting an employeeId param — per the spec, email *content* is
 * employee-only (managers/admins get aggregated analytics, not raw inboxes),
 * so there's no scoping decision to make here beyond "always self."
 */

async function getOwnGmailAccountOr404(employeeId: string) {
  const account = await prisma.gmailAccount.findUnique({ where: { employeeId } });
  if (!account) return null;
  return account;
}

emailsRouter.post("/sync", requireAuth, async (req, res) => {
  try {
    const result = await syncEmployeeInbox(req.user!.employeeId);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
  unreadOnly: z.coerce.boolean().optional(),
  starredOnly: z.coerce.boolean().optional(),
  includeTrashed: z.coerce.boolean().optional(),
  search: z.string().optional(),
});

emailsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query params" });

  const account = await getOwnGmailAccountOr404(req.user!.employeeId);
  if (!account) return res.json({ emails: [], nextCursor: null });

  const { limit, cursor, unreadOnly, starredOnly, includeTrashed, search } = parsed.data;
  const emails = await prisma.email.findMany({
    where: {
      gmailAccountId: account.id,
      ...(unreadOnly ? { isRead: false } : {}),
      ...(starredOnly ? { isStarred: true } : {}),
      ...(includeTrashed ? {} : { isTrashed: false }),
      ...(search
        ? {
            OR: [
              { subject: { contains: search, mode: "insensitive" } },
              { fromAddress: { contains: search, mode: "insensitive" } },
              { fromName: { contains: search, mode: "insensitive" } },
              { snippet: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    // Inbox list only ever renders subject/from/snippet/flags (see
    // Home.tsx's list row + the `selectedListItem` fallback, which is
    // designed to tolerate heavier fields arriving later via GET /:id —
    // same pattern already used there for attachments). Leaving out
    // bodyText/aiSummary/aiPriorityRationale/aiSuggestedReply (all
    // @db.Text, some can be several KB each) cuts the list payload
    // substantially with no change to what's rendered here.
    select: {
      id: true,
      gmailAccountId: true,
      gmailMessageId: true,
      threadId: true,
      fromAddress: true,
      fromName: true,
      toAddresses: true,
      subject: true,
      receivedAt: true,
      isRead: true,
      isReplied: true,
      repliedAt: true,
      snippet: true,
      isStarred: true,
      isTrashed: true,
      aiPriorityScore: true,
      category: true,
    },
  });

  const nextCursor = emails.length > limit ? emails[limit].id : null;
  return res.json({ emails: emails.slice(0, limit), nextCursor });
});

// "Sent" tab — outgoing messages live in the Reply table (not as Email rows),
// so this is a real query rather than the empty [] the employee-app used to
// hardcode client-side. Ordered most-recent-first like the inbox list.
emailsRouter.get("/sent", requireAuth, async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const replies = await prisma.reply.findMany({
    where: { employeeId: req.user!.employeeId },
    orderBy: { sentAt: "desc" },
    take: limit,
    include: { email: { include: { category: true } } },
  });
  return res.json({
    sent: replies.map((r: (typeof replies)[number]) => ({
      replyId: r.id,
      sentAt: r.sentAt,
      wasAIDraft: r.wasAIDraft,
      wasAIEdited: r.wasAIEdited,
      replyTimeSec: r.replyTimeSec,
      email: r.email,
    })),
  });
});

emailsRouter.get("/:id", requireAuth, async (req, res) => {
  const email = await prisma.email.findUnique({
    where: { id: req.params.id },
    include: { gmailAccount: true, category: true, replies: true, attachments: true },
  });
  if (!email || email.gmailAccount.employeeId !== req.user!.employeeId) {
    return res.status(404).json({ error: "Email not found" });
  }
  return res.json({ email });
});

// Full thread: every synced message that shares this email's threadId, on
// the same mail account, oldest-first (reading order). Falls back to just
// this email when threadId is null (manual/pasted emails, or providers that
// didn't give us one) rather than erroring.
emailsRouter.get("/:id/thread", requireAuth, async (req, res) => {
  const email = await assertOwnsEmail(req.user!.employeeId, req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });

  if (!email.threadId) {
    return res.json({ thread: [email] });
  }

  const thread = await prisma.email.findMany({
    where: { gmailAccountId: email.gmailAccountId, threadId: email.threadId },
    orderBy: { receivedAt: "asc" },
    include: { category: true, attachments: true },
  });
  return res.json({ thread });
});

async function assertOwnsEmail(employeeId: string, emailId: string) {
  const email = await prisma.email.findUnique({ where: { id: emailId }, include: { gmailAccount: true } });
  if (!email || email.gmailAccount.employeeId !== employeeId) return null;
  return email;
}

function threadContentFor(email: { subject: string | null; fromAddress: string; bodyText: string | null; snippet: string | null }) {
  return `Subject: ${email.subject ?? ""}\nFrom: ${email.fromAddress}\n\n${email.bodyText ?? email.snippet ?? ""}`;
}

// Cached AI insights for this email (whatever's been generated so far).
emailsRouter.get("/:id/insights", requireAuth, async (req, res) => {
  const email = await assertOwnsEmail(req.user!.employeeId, req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });
  const actionIds = await latestActionIds(email.id);
  return res.json({
    summary: email.aiSummary,
    priorityScore: email.aiPriorityScore,
    priorityRationale: email.aiPriorityRationale,
    suggestedReply: email.aiSuggestedReply,
    ...actionIds,
  });
});

const genOptsSchema = z.object({ force: z.boolean().optional() });

emailsRouter.post("/:id/summary", requireAuth, async (req, res) => {
  const email = await assertOwnsEmail(req.user!.employeeId, req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });
  const { force } = genOptsSchema.parse(req.body ?? {});
  if (!force && email.aiSummary) return res.json({ summary: email.aiSummary });
  try {
    const result = await summarizeEmailThread(req.user!.employeeId, email.id, threadContentFor(email));
    return res.json(result);
  } catch (err: any) {
    console.error("[AI summary] failed:", err);
    return res.status(500).json({ error: "Failed to generate summary. Check GROQ_API_KEY is configured correctly." });
  }
});

emailsRouter.post("/:id/priority", requireAuth, async (req, res) => {
  const email = await assertOwnsEmail(req.user!.employeeId, req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });
  const { force } = genOptsSchema.parse(req.body ?? {});
  if (!force && email.aiPriorityScore != null) {
    return res.json({ priorityScore: email.aiPriorityScore, priorityRationale: email.aiPriorityRationale });
  }
  try {
    const result = await scoreEmailPriority(req.user!.employeeId, email.id, threadContentFor(email));
    return res.json(result);
  } catch (err: any) {
    console.error("[AI priority] failed:", err);
    return res.status(500).json({ error: "Failed to score priority. Check GROQ_API_KEY is configured correctly." });
  }
});

emailsRouter.post("/:id/suggested-reply", requireAuth, async (req, res) => {
  const email = await assertOwnsEmail(req.user!.employeeId, req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });
  const { force } = genOptsSchema.parse(req.body ?? {});
  if (!force && email.aiSuggestedReply) return res.json({ suggestedReply: email.aiSuggestedReply });
  try {
    const result = await suggestEmailReply(req.user!.employeeId, email.id, threadContentFor(email));
    return res.json(result);
  } catch (err: any) {
    console.error("[AI suggested-reply] failed:", err);
    return res.status(500).json({ error: "Failed to generate suggested reply. Check GROQ_API_KEY is configured correctly." });
  }
});

const outcomeSchema = z.object({ aiActionId: z.string(), accepted: z.boolean() });
emailsRouter.post("/ai-actions/outcome", requireAuth, async (req, res) => {
  const parsed = outcomeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
  const action = await prisma.aIAction.findUnique({ where: { id: parsed.data.aiActionId } });
  if (!action || action.employeeId !== req.user!.employeeId) {
    return res.status(404).json({ error: "AI action not found" });
  }
  await recordAISuggestionOutcome(parsed.data.aiActionId, parsed.data.accepted);
  return res.json({ success: true });
});

// Downloads one inbound attachment's raw bytes. Scoped through the parent
// email's ownership check (not just the attachment id) so an attachment id
// alone never leaks another employee's file.
emailsRouter.get("/:id/attachments/:attachmentId", requireAuth, async (req, res) => {
  const email = await assertOwnsEmail(req.user!.employeeId, req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });

  const attachment = await prisma.attachment.findUnique({ where: { id: req.params.attachmentId } });
  if (!attachment || attachment.emailId !== email.id) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  try {
    const bytes = await readAttachment(attachment.storageKey);
    res.setHeader("Content-Type", attachment.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${attachment.filename.replace(/"/g, "")}"`);
    return res.send(bytes);
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to read attachment" });
  }
});

const attachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  data: z.string(), // base64
});

const replySchema = z.object({
  body: z.string().min(1),
  wasAIDraft: z.boolean().default(false),
  wasAIEdited: z.boolean().default(false),
  attachments: z.array(attachmentSchema).optional(),
});

emailsRouter.post("/:id/reply", requireAuth, async (req, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  try {
    const reply = await sendReply(req.user!.employeeId, req.params.id, parsed.data.body, {
      wasAIDraft: parsed.data.wasAIDraft,
      wasAIEdited: parsed.data.wasAIEdited,
      attachments: parsed.data.attachments,
    });
    return res.json({ reply });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Mark read/unread, star/unstar, trash — the employee-app's action bar.
const patchSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isTrashed: z.boolean().optional(),
});

emailsRouter.patch("/:id", requireAuth, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const email = await assertOwnsEmail(req.user!.employeeId, req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });

  const updated = await prisma.email.update({ where: { id: email.id }, data: parsed.data });
  return res.json({ email: updated });
});

// "Paste email manually" — for employees with no connected mailbox yet.
// Lazily creates a MANUAL GmailAccount row to satisfy Email's required FK
// (see imapAccountService.getOrCreateManualAccount for why).
const manualSchema = z.object({
  subject: z.string().optional(),
  fromAddress: z.string().optional(),
  bodyText: z.string().min(1),
});

emailsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const account = await getOrCreateManualAccount(req.user!.employeeId, req.user!.companyId);

  const email = await prisma.email.create({
    data: {
      gmailAccountId: account.id,
      gmailMessageId: nanoid(),
      threadId: nanoid(),
      fromAddress: parsed.data.fromAddress || "unknown@unknown",
      subject: parsed.data.subject || null,
      receivedAt: new Date(),
      isRead: true,
      bodyText: parsed.data.bodyText,
      snippet: parsed.data.bodyText.slice(0, 160),
    },
  });

  return res.json({ email });
});
