import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the service
vi.mock("../src/lib/db", () => ({
  prisma: {
    gmailAccount: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// Mock ImapFlow
const mockImapConnect = vi.fn();
const mockImapLogout = vi.fn();
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockImapConnect,
    logout: mockImapLogout,
  })),
}));

// Mock nodemailer
const mockSmtpVerify = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockImplementation(() => ({
      verify: mockSmtpVerify,
    })),
  },
}));

// Import service and prisma after mocking
const { connectImapAccount, getOrCreateManualAccount } = await import("../src/services/imapAccountService");
const { prisma } = await import("../src/lib/db");

describe("imapAccountService", () => {
  const employeeId = "emp-123";
  const companyId = "comp-456";
  const mockInput = {
    email: "test@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapUser: "test@example.com",
    imapPass: "password",
    imapSecure: true,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpUser: "test@example.com",
    smtpPass: "password",
    smtpSecure: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("connectImapAccount", () => {
    it("successfully connects and upserts an IMAP account", async () => {
      mockImapConnect.mockResolvedValue(undefined);
      mockImapLogout.mockResolvedValue(undefined);
      mockSmtpVerify.mockResolvedValue(true);
      
      vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.gmailAccount.upsert).mockResolvedValue({
        id: "acc-1",
        emailAddress: mockInput.email,
        status: "CONNECTED",
      } as any);

      const result = await connectImapAccount(employeeId, companyId, mockInput);

      expect(mockImapConnect).toHaveBeenCalled();
      expect(mockSmtpVerify).toHaveBeenCalled();
      expect(prisma.gmailAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { employeeId },
        create: expect.objectContaining({
          provider: "IMAP",
          emailAddress: mockInput.email,
        }),
      }));
      expect(result).toEqual({ id: "acc-1", emailAddress: mockInput.email, status: "CONNECTED" });
    });

    it("throws error if email is already connected to another employee", async () => {
      mockImapConnect.mockResolvedValue(undefined);
      mockSmtpVerify.mockResolvedValue(true);
      
      vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue({
        employeeId: "other-emp",
      } as any);

      await expect(connectImapAccount(employeeId, companyId, mockInput))
        .rejects.toThrow(/already connected to a different employee/);
      
      expect(prisma.gmailAccount.upsert).not.toHaveBeenCalled();
    });

    it("fails if IMAP verification fails", async () => {
      mockImapConnect.mockRejectedValue(new Error("IMAP Auth Failed"));

      await expect(connectImapAccount(employeeId, companyId, mockInput))
        .rejects.toThrow("IMAP Auth Failed");
      
      expect(prisma.gmailAccount.upsert).not.toHaveBeenCalled();
    });
  });

  describe("getOrCreateManualAccount", () => {
    it("returns existing account if it exists", async () => {
      const existing = { id: "acc-manual", provider: "MANUAL" };
      vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue(existing as any);

      const result = await getOrCreateManualAccount(employeeId, companyId);

      expect(result).toBe(existing);
      expect(prisma.gmailAccount.create).not.toHaveBeenCalled();
    });

    it("creates new manual account if none exists", async () => {
      vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.gmailAccount.create).mockResolvedValue({ id: "new-manual" } as any);

      const result = await getOrCreateManualAccount(employeeId, companyId);

      expect(prisma.gmailAccount.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          provider: "MANUAL",
          employeeId,
        }),
      }));
      expect(result.id).toBe("new-manual");
    });
  });
});
