import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mailparser
vi.mock("mailparser", () => ({
  simpleParser: vi.fn().mockResolvedValue({
    from: { value: [{ address: "sender@example.com", name: "Sender" }] },
    to: { value: [{ address: "receiver@example.com" }] },
    subject: "Test Subject",
    text: "Test Body Content",
    messageId: "msg-123",
    date: new Date("2023-01-01T00:00:00Z"),
    attachments: [],
  }),
}));

// Mock ImapFlow
const mockSearch = vi.fn();
const mockFetchOne = vi.fn();
const mockGetMailboxLock = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn().mockResolvedValue(undefined);

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    logout: mockLogout,
    getMailboxLock: mockGetMailboxLock,
    search: mockSearch,
    fetchOne: mockFetchOne,
  })),
}));

// Mock crypto
vi.mock("../src/lib/crypto", () => ({
  decryptToken: vi.fn().mockReturnValue("decrypted-pass"),
}));

const { fetchImapMessages } = await import("../src/services/imapSync");
const { simpleParser } = await import("mailparser");

describe("imapSync", () => {
  const mockAccount = {
    id: "acc-1",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapUser: "user@example.com",
    imapSecure: true,
    accessToken: "encrypted-pass",
    lastSyncedAt: new Date("2023-01-01T00:00:00Z"),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMailboxLock.mockResolvedValue({ release: vi.fn() });
  });

  it("successfully fetches and parses messages", async () => {
    mockSearch.mockResolvedValue([1, 2]);
    mockFetchOne.mockResolvedValue({
      source: Buffer.from("raw email source"),
      flags: new Set(["\\Seen"]),
    });

    const messages = await fetchImapMessages(mockAccount);

    expect(mockConnect).toHaveBeenCalled();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ since: mockAccount.lastSyncedAt }),
      { uid: true }
    );
    expect(mockFetchOne).toHaveBeenCalledTimes(2);
    expect(simpleParser).toHaveBeenCalledTimes(2);
    
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      fromAddress: "sender@example.com",
      subject: "Test Subject",
      isRead: true,
    });
  });

  it("handles missing connection details", async () => {
    const invalidAccount = { ...mockAccount, imapHost: null };
    await expect(fetchImapMessages(invalidAccount)).rejects.toThrow(/missing connection details/);
  });

  it("filters out oversized attachments", async () => {
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from("source"), flags: new Set() });
    
    vi.mocked(simpleParser).mockResolvedValueOnce({
      from: { value: [{ address: "s@e.com" }] },
      attachments: [
        {
          filename: "large.pdf",
          contentType: "application/pdf",
          content: Buffer.alloc(30 * 1024 * 1024), // 30MB
          contentDisposition: "attachment",
        },
        {
          filename: "small.txt",
          contentType: "text/plain",
          content: Buffer.from("hello"),
          contentDisposition: "attachment",
        }
      ],
    } as any);

    const messages = await fetchImapMessages(mockAccount);
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments[0].filename).toBe("small.txt");
  });

  it("derives bodyText from HTML when there's no text/plain part (HTML-only mail)", async () => {
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue({ source: Buffer.from("source"), flags: new Set() });

    // Reflects real-world HTML-only mail (marketing/invoices/notifications):
    // mailparser gives back `text: undefined` when there's no text/plain part.
    vi.mocked(simpleParser).mockResolvedValueOnce({
      from: { value: [{ address: "billing@vendor.com" }] },
      subject: "Your invoice is ready",
      html: "<html><body><h1>Invoice</h1><p>Amount due: <b>$42.00</b></p><p>Thanks!</p></body></html>",
      text: undefined,
      attachments: [],
    } as any);

    const messages = await fetchImapMessages(mockAccount);

    expect(messages[0].bodyHtml).toContain("<b>$42.00</b>");
    // The old behavior left bodyText === "" here, which meant the reader
    // pane fell back to a 160-char snippet and the AI pipeline
    // (categorize/priority/summary) ran on effectively no content.
    expect(messages[0].bodyText).not.toBe("");
    expect(messages[0].bodyText).toContain("Amount due: $42.00");
    expect(messages[0].snippet.length).toBeGreaterThan(0);
  });

  it("ensures logout is called even on error", async () => {
    mockConnect.mockRejectedValue(new Error("Connection failed"));
    
    await expect(fetchImapMessages(mockAccount)).rejects.toThrow("Connection failed");
    expect(mockLogout).toHaveBeenCalled();
  });
});
