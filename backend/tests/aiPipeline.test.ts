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
        choices: [{ message: { content: JSON.stringify({ label: "Billing", confidence: 0.9 }) } }]
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result).toEqual({ label: "Billing", confidence: 0.9 });
      expect(prisma.emailCategory.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { emailId },
        create: expect.objectContaining({ label: "Billing", confidence: 0.9 }),
      }));
    });

    it("falls back to Other on malformed LLM response", async () => {
      vi.mocked(invokeLLM).mockResolvedValue({
        choices: [{ message: { content: "not json" } }]
      } as any);

      const result = await categorizeEmail(employeeId, emailId, threadContent);

      expect(result.label).toBe("Other");
      expect(prisma.emailCategory.upsert).toHaveBeenCalled();
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
