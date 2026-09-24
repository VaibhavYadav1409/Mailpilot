import { describe, it, expect, vi, beforeEach } from "vitest";

// Same approach as rbac.test.ts: mock the db module so these tests need no
// database or generated client. Only the MSI models (plus auditLog, which the
// service writes to) exist on this fake — if the purge ever reached for any
// other model (email, employee, gmailAccount...), the test would throw.
const msiDailyReport = {
  findMany: vi.fn(),
  deleteMany: vi.fn(),
};
const msiReportFile = { deleteMany: vi.fn() };
vi.mock("../src/lib/db", () => ({
  prisma: new Proxy(
    { msiDailyReport, msiReportFile, auditLog: { create: vi.fn().mockResolvedValue({}) } },
    {
      get(target, prop: string) {
        if (!(prop in target)) throw new Error(`MSI code touched non-MSI model: ${prop}`);
        return (target as Record<string, unknown>)[prop];
      },
    },
  ),
}));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const svc = await import("../src/services/msiService");

const IST = "Asia/Kolkata";

describe("business dates (server-side, timezone-aware)", () => {
  it("uses the business timezone, not UTC", () => {
    // 20:00 UTC on 23 Sep is 01:30 IST on 24 Sep.
    expect(svc.businessDateString(new Date("2026-09-23T20:00:00Z"), IST)).toBe("2026-09-24");
    expect(svc.businessDateString(new Date("2026-09-23T18:00:00Z"), IST)).toBe("2026-09-23");
  });

  it("adds calendar days across month boundaries", () => {
    expect(svc.addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(svc.addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("finds local midnight as a real instant (IST = UTC+5:30)", () => {
    expect(svc.startOfBusinessDay("2026-09-26", IST).toISOString()).toBe("2026-09-25T18:30:00.000Z");
  });

  it("finds local midnight correctly in a DST zone", () => {
    // New York is UTC-4 in summer, UTC-5 in winter.
    expect(svc.startOfBusinessDay("2026-07-01", "America/New_York").toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(svc.startOfBusinessDay("2026-12-01", "America/New_York").toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });
});

describe("retention policy: 24 Sep report -> deleted from 26 Sep 00:00", () => {
  const expires = svc.expiresAtFor("2026-09-24", IST);

  it("expires at 26 Sep 00:00 IST", () => {
    expect(svc.RETENTION_DAYS).toBe(2);
    expect(expires.toISOString()).toBe("2026-09-25T18:30:00.000Z");
  });

  it("is active all of 24 and 25 Sep, expired from 26 Sep", () => {
    const at = (iso: string) => new Date(iso) < expires;
    expect(at("2026-09-24T09:00:00+05:30")).toBe(true);
    expect(at("2026-09-25T23:59:59+05:30")).toBe(true);
    expect(at("2026-09-26T00:00:00+05:30")).toBe(false);
  });

  it("only today and yesterday are available dates", () => {
    expect(svc.availableDates(new Date("2026-09-24T10:00:00+05:30"), IST)).toEqual(["2026-09-24", "2026-09-23"]);
  });
});

describe("file validation", () => {
  const b64 = (buf: Buffer) => buf.toString("base64");
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 1)]);
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 1)]);

  it("requires a file", () => {
    expect(() => svc.validateFile(undefined)).toThrow("Please select your daily report.");
  });

  it("accepts real business documents and decides the MIME type itself", () => {
    const v = svc.validateFile({ fileName: "Daily_Report_24Sep.pdf", dataBase64: b64(pdf) });
    expect(v.fileType).toBe("application/pdf");
    expect(v.data.equals(pdf)).toBe(true);
    expect(svc.validateFile({ fileName: "r.docx", dataBase64: b64(docx) }).fileType).toContain("wordprocessingml");
    expect(svc.validateFile({ fileName: "r.csv", dataBase64: b64(Buffer.from("a,b\n1,2\n")) }).fileType).toBe("text/csv");
  });

  it("rejects unsupported extensions", () => {
    expect(() => svc.validateFile({ fileName: "run.exe", dataBase64: b64(pdf) })).toThrow("This file type is not supported.");
    expect(() => svc.validateFile({ fileName: "noext", dataBase64: b64(pdf) })).toThrow("This file type is not supported.");
  });

  it("rejects a file whose bytes don't match its extension", () => {
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(50, 0)]);
    expect(() => svc.validateFile({ fileName: "report.pdf", dataBase64: b64(exe) })).toThrow("This file type is not supported.");
    expect(() => svc.validateFile({ fileName: "report.txt", dataBase64: b64(exe) })).toThrow("This file type is not supported.");
  });

  it("rejects oversized files", () => {
    const big = Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(svc.getMsiMaxFileBytes() + 10, 1)]);
    expect(() => svc.validateFile({ fileName: "big.pdf", dataBase64: b64(big) })).toThrow("File exceeds the allowed size.");
  });

  it("rejects empty files", () => {
    expect(() => svc.validateFile({ fileName: "e.txt", dataBase64: "====" })).toThrow();
  });
});

describe("filename sanitizing", () => {
  it("strips paths and traversal", () => {
    expect(svc.sanitizeFileName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(svc.sanitizeFileName("C:\\Users\\x\\report.pdf")).toBe("report.pdf");
    expect(svc.sanitizeFileName("..hidden.pdf")).toBe("hidden.pdf");
  });
  it("removes control/reserved characters and caps length, keeping the extension", () => {
    expect(svc.sanitizeFileName('a<b>:"c|?*\u0001.pdf')).toBe("a_b___c___.pdf");
    const long = svc.sanitizeFileName("x".repeat(400) + ".xlsx");
    expect(long.length).toBeLessThanOrEqual(150);
    expect(long.endsWith(".xlsx")).toBe(true);
  });
});

describe("important message", () => {
  it("trims and treats blank as none", () => {
    expect(svc.normalizeMessage("  hi  ")).toBe("hi");
    expect(svc.normalizeMessage("   ")).toBeNull();
    expect(svc.normalizeMessage(undefined)).toBeNull();
  });
  it("caps length", () => {
    expect(() => svc.normalizeMessage("x".repeat(2001))).toThrow();
  });
});

describe("admin filter", () => {
  const row = (id: string, important: boolean | null) => ({
    employeeId: id,
    name: id,
    email: `${id}@x`,
    department: null,
    role: "EMPLOYEE",
    submitted: important !== null,
    report: important === null ? null : ({ hasImportantMessage: important } as any),
  });
  const overview = { submitted: [row("a", true), row("b", false)], notSubmitted: [row("c", null)] };

  it("filters submitted / not submitted / important", () => {
    expect(svc.applyAdminFilter(overview, "submitted").notSubmitted).toHaveLength(0);
    expect(svc.applyAdminFilter(overview, "not_submitted").submitted).toHaveLength(0);
    const imp = svc.applyAdminFilter(overview, "important");
    expect(imp.submitted.map((s) => s.employeeId)).toEqual(["a"]);
    expect(imp.notSubmitted).toHaveLength(0);
    expect(svc.applyAdminFilter(overview, "all")).toBe(overview);
  });
});

describe("purgeExpiredMsiReports", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes only expired MSI rows and their files, and never touches other models", async () => {
    const now = new Date("2026-09-26T00:30:00+05:30");
    const key = "msi/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222";
    msiDailyReport.findMany
      .mockResolvedValueOnce([{ id: "r1", storageReference: key, companyId: "c1" }]) // expired batch
      .mockResolvedValueOnce([]); // live refs for orphan sweep
    msiDailyReport.deleteMany.mockResolvedValueOnce({ count: 1 });
    msiReportFile.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const r = await svc.purgeExpiredMsiReports(now);

    expect(msiDailyReport.findMany.mock.calls[0][0].where).toEqual({ expiresAt: { lte: now } });
    expect(msiDailyReport.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r1"] } } });
    expect(msiReportFile.deleteMany.mock.calls[0][0]).toEqual({ where: { storageKey: { in: [key] } } });
    expect(r).toMatchObject({ reportsDeleted: 1, filesDeleted: 1, orphanFilesDeleted: 0 });
  });

  it("is a cheap no-op when nothing has expired", async () => {
    msiDailyReport.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    msiReportFile.deleteMany.mockResolvedValueOnce({ count: 0 });
    const r = await svc.purgeExpiredMsiReports(new Date());
    expect(msiDailyReport.deleteMany).not.toHaveBeenCalled();
    expect(r.reportsDeleted).toBe(0);
  });
});
