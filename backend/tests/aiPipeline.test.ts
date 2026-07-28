import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../src/lib/db", () => ({
  prisma: {
    aIAction: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    emailCategory: {
      upsert: vi.fn(),
    },
    email: {
      update: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/llm", () => ({
  invokeLLM: vi.fn(),
}));

const { 
  categorizeEmail, 
  scoreEmailPriority, 
  summarizeEmailThread, 
  suggestEmailReply,
  latestActionIds 
} = await import("../src/services/aiPipeline");
const { prisma } = await import("../src/lib/db");
const { invokeLLM } = await import("../src/lib/llm");

describe("aiPipeline", () => {
  const employeeId = "emp-1";
  const emailId = "email-1";
  const threadContent = "Hello, I have a billing question.";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for logging actions
    vi.mocked(prisma.aIAction.create).mockResolvedValue({ id: "action-1" } as any);
  });

  describe("categorizeEmail", () => {
    it("successfully categorizes email", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({ label: "Billing", confidence: 0.9, replyClass: "NEEDS_REPLY" }),
            },
          },
        ],
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result).toEqual({
        label: "Billing",
        confidence: 0.9,
        replyClass: "NEEDS_REPLY",
        requiresReply: true,
      });
      expect(prisma.emailCategory.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { emailId },
        create: expect.objectContaining({ label: "Billing", confidence: 0.9 }),
      }));
    });

    it("persists the reply-worthiness verdict onto the Email row", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({ label: "Internal", confidence: 0.8, replyClass: "ACKNOWLEDGMENT" }),
            },
          },
        ],
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result.requiresReply).toBe(false);
      expect(prisma.email.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: emailId },
          data: expect.objectContaining({
            requiresReply: false,
            replyClassification: "ACKNOWLEDGMENT",
          }),
        })
      );
    });

    // Promotional mail is decided by headers at sync time, not by the model —
    // a stray NEEDS_REPLY must not drag a newsletter back into Pending.
    it("forces promotional mail to AUTOMATED even if the model says NEEDS_REPLY", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                label: "Spam/Promotional",
                confidence: 0.95,
                replyClass: "NEEDS_REPLY",
              }),
            },
          },
        ],
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result.replyClass).toBe("AUTOMATED");
      expect(result.requiresReply).toBe(false);
    });

    it("falls back to Other on malformed LLM response", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [{ message: { content: "not json" } }]
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result.label).toBe("Other");
      expect(prisma.emailCategory.upsert).toHaveBeenCalled();
    });

    // The safety property: a parse failure must never be what removes an
    // email from someone's Unreplied list.
    it("treats a malformed LLM response as needing a reply", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [{ message: { content: "not json" } }]
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result.replyClass).toBe("NEEDS_REPLY");
      expect(result.requiresReply).toBe(true);
    });

    it("treats an unrecognized replyClass as needing a reply", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [
          { message: { content: JSON.stringify({ label: "Support Request", replyClass: "banana" }) } },
        ],
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result.requiresReply).toBe(true);
    });
  });

  describe("scoreEmailPriority", () => {
    it("successfully scores priority", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ score: 8, rationale: "Urgent billing issue" }) } }]
      } as any);

      const result = await scoreEmailPriority(employeeId, emailId, threadContent);

      expect(result.priorityScore).toBe(8);
      expect(prisma.email.update).toHaveBeenCalledWith({
        where: { id: emailId },
        data: { aiPriorityScore: 8, aiPriorityRationale: "Urgent billing issue" },
      });
    });
  });

  describe("summarizeEmailThread", () => {
    it("successfully summarizes thread", async () => {
      const summaryText = "Customer is asking about their latest invoice.";
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [{ message: { content: summaryText } }]
      } as any);

      const result = await summarizeEmailThread(employeeId, emailId, threadContent);

      expect(result.summary).toBe(summaryText);
      expect(prisma.email.update).toHaveBeenCalledWith({
        where: { id: emailId },
        data: { aiSummary: summaryText },
      });
    });
  });

  describe("latestActionIds", () => {
    it("returns mapped action IDs", async () => {
      vi.mocked(prisma.aIAction.findMany).mockResolvedValue([
        { id: "s-1", actionType: "SUMMARY" },
        { id: "p-1", actionType: "PRIORITY_SCORE" },
        { id: "r-1", actionType: "SUGGEST_REPLY" },
      ] as any);

      const result = await latestActionIds(emailId);

      expect(result).toEqual({
        summaryActionId: "s-1",
        priorityActionId: "p-1",
        suggestedReplyActionId: "r-1",
      });
    });

    it("returns null for missing action types", async () => {
      vi.mocked(prisma.aIAction.findMany).mockResolvedValue([]);
      const result = await latestActionIds(emailId);
      expect(result.summaryActionId).toBeNull();
    });
  });
});
