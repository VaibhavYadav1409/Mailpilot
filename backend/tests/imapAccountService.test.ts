import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the service
vi.mock("../src/lib/db", () => ({
  prisma: {
    gmailAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// Mock ImapFlow
const mockImapConnect = vi.fn();
const mockImapLogout = vi.fn();
const mockImapClose = vi.fn();
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockImapConnect,
    logout: mockImapLogout,
    close: mockImapClose,
  })),
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
    vi.mocked(prisma.gmailAccount.updateMany).mockResolvedValue({ count: 0 } as any);
  });

  describe("connectImapAccount", () => {
    it("creates a new IMAP account when the mailbox isn't already on file, then deactivates other accounts", async () => {
      mockImapConnect.mockResolvedValue(undefined);
      mockImapLogout.mockResolvedValue(undefined);

      vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.gmailAccount.create).mockResolvedValue({
        id: "acc-1",
        emailAddress: mockInput.email,
        status: "CONNECTED",
      } as any);

      const result = await connectImapAccount(employeeId, companyId, mockInput);

      expect(mockImapConnect).toHaveBeenCalled();
      expect(prisma.gmailAccount.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          employeeId,
          provider: "IMAP",
          emailAddress: mockInput.email,
          isActive: true,
        }),
      }));
      // Every other active account for this employee should be deactivated
      // once the new one is created — that's the account-switching contract.
      expect(prisma.gmailAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ employeeId, isActive: true, id: { not: "acc-1" } }),
        data: { isActive: false },
      }));
      expect(result).toEqual({ id: "acc-1", emailAddress: mockInput.email, status: "CONNECTED" });
    });

    it("updates the existing row in place when reconnecting the same mailbox for the same employee", async () => {
      mockImapConnect.mockResolvedValue(undefined);
      mockImapLogout.mockResolvedValue(undefined);

      vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue({
        id: "acc-existing",
        employeeId,
        emailAddress: mockInput.email,
      } as any);
      vi.mocked(prisma.gmailAccount.update).mockResolvedValue({
        id: "acc-existing",
        emailAddress: mockInput.email,
        status: "CONNECTED",
      } as any);

      const result = await connectImapAccount(employeeId, companyId, mockInput);

      expect(prisma.gmailAccount.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "acc-existing" },
        data: expect.objectContaining({ provider: "IMAP", isActive: true }),
      }));
      expect(prisma.gmailAccount.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "acc-existing", emailAddress: mockInput.email, status: "CONNECTED" });
    });

    it("throws error if email is already connected to another employee", async () => {
      mockImapConnect.mockResolvedValue(undefined);

      vi.mocked(prisma.gmailAccount.findUnique).mockResolvedValue({
        employeeId: "other-emp",
      } as any);

      await expect(connectImapAccount(employeeId, companyId, mockInput))
        .rejects.toThrow(/already connected to a different employee/);

      expect(prisma.gmailAccount.create).not.toHaveBeenCalled();
      expect(prisma.gmailAccount.update).not.toHaveBeenCalled();
    });

    it("fails if IMAP verification fails", async () => {
      mockImapConnect.mockRejectedValue(new Error("IMAP Auth Failed"));

      await expect(connectImapAccount(employeeId, companyId, mockInput))
        .rejects.toThrow("IMAP Auth Failed");

      expect(prisma.gmailAccount.create).not.toHaveBeenCalled();
      expect(prisma.gmailAccount.update).not.toHaveBeenCalled();
    });
  });

  describe("getOrCreateManualAccount", () => {
    it("returns the existing active account if one exists", async () => {
      const existing = { id: "acc-manual", provider: "MANUAL", isActive: true };
      vi.mocked(prisma.gmailAccount.findFirst).mockResolvedValue(existing as any);

      const result = await getOrCreateManualAccount(employeeId, companyId);

      expect(prisma.gmailAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { employeeId, isActive: true } })
      );
      expect(result).toBe(existing);
      expect(prisma.gmailAccount.create).not.toHaveBeenCalled();
    });

    it("creates a new active manual account if none exists", async () => {
      vi.mocked(prisma.gmailAccount.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.gmailAccount.create).mockResolvedValue({ id: "new-manual" } as any);

      const result = await getOrCreateManualAccount(employeeId, companyId);

      expect(prisma.gmailAccount.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          provider: "MANUAL",
          employeeId,
          isActive: true,
        }),
      }));
      expect(result.id).toBe("new-manual");
    });
  });
});
