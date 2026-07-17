import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../src/lib/db", () => ({
  prisma: {
    email: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    reply: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../src/services/gmailAccountService", () => ({
  getValidAccessToken: vi.fn(),
}));

vi.mock("../src/lib/crypto", () => ({
  decryptToken: vi.fn((t) => t), // Identity for tests
}));

const mockSendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockImplementation(() => ({
      sendMail: mockSendMail,
    })),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const { sendReply } = await import("../src/services/emailActions");
const { prisma } = await import("../src/lib/db");
const { getValidAccessToken } = await import("../src/services/gmailAccountService");

describe("emailActions", () => {
  const employeeId = "emp-1";
  const emailId = "email-1";
  const body = "This is a reply.";
  const mockEmail = {
    id: emailId,
    subject: "Original Subject",
    fromAddress: "customer@example.com",
    threadId: "thread-123",
    receivedAt: new Date(Date.now() - 60000), // 1 minute ago
    gmailAccount: {
      employeeId,
      emailAddress: "employee@company.com",
      provider: "GMAIL",
      isActive: true,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends reply via Gmail successfully", async () => {
    vi.mocked(prisma.email.findUnique).mockResolvedValue(mockEmail as any);
    vi.mocked(getValidAccessToken).mockResolvedValue("fake-token");
    mockFetch.mockResolvedValue({ ok: true });
    vi.mocked(prisma.reply.create).mockResolvedValue({ id: "reply-1" } as any);

    const result = await sendReply(employeeId, emailId, body, { wasAIDraft: false, wasAIEdited: false });

    expect(getValidAccessToken).toHaveBeenCalledWith(employeeId);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer fake-token" }),
      })
    );
    expect(prisma.reply.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        replyTimeSec: expect.any(Number),
      }),
    }));
    expect(result.id).toBe("reply-1");
  });

  it("blocks sending for IMAP accounts (Conditional Sending — read-only in MailPilot)", async () => {
    const imapEmail = {
      ...mockEmail,
      gmailAccount: {
        ...mockEmail.gmailAccount,
        provider: "IMAP",
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpUser: "user",
        refreshToken: "encrypted-pass",
      },
    };
    vi.mocked(prisma.email.findUnique).mockResolvedValue(imapEmail as any);

    await expect(sendReply(employeeId, emailId, body, { wasAIDraft: true, wasAIEdited: false }))
      .rejects.toThrow(/not available for IMAP accounts/);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(prisma.reply.create).not.toHaveBeenCalled();
  });

  it("throws error if email does not belong to employee", async () => {
    vi.mocked(prisma.email.findUnique).mockResolvedValue({
      ...mockEmail,
      gmailAccount: { employeeId: "other-emp" },
    } as any);

    await expect(sendReply(employeeId, emailId, body, { wasAIDraft: false, wasAIEdited: false }))
      .rejects.toThrow(/does not belong to your connected mail account/);
  });

  it("throws error for MANUAL provider", async () => {
    vi.mocked(prisma.email.findUnique).mockResolvedValue({
      ...mockEmail,
      gmailAccount: { employeeId, provider: "MANUAL", isActive: true },
    } as any);

    await expect(sendReply(employeeId, emailId, body, { wasAIDraft: false, wasAIEdited: false }))
      .rejects.toThrow(/no connected mailbox to send from/);
  });
});
