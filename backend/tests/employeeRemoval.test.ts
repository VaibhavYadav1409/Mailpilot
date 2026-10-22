import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const op = (name: string) => vi.fn(async () => (calls.push(name), { count: 1 }));
const tx: any = {};
for (const m of ["attachment", "emailCategory", "reply", "aIAction", "email", "gmailAccount", "session", "dailyAnalytics", "msiDailyReport", "misCheckEvent", "misDailyCheck", "misSource", "misCircleMark", "misEmailLog", "misLeave", "auditLog", "department", "employee"]) {
  tx[m] = { deleteMany: op(`${m}.deleteMany`), updateMany: op(`${m}.updateMany`), delete: op(`${m}.delete`), create: op(`${m}.create`) };
}
const target = { id: "e9", firstName: "Raghav", lastName: "", email: "raghav", role: "EMPLOYEE", gmailAccounts: [{ id: "g1" }] };
vi.mock("../src/lib/db", () => ({
  prisma: {
    employee: { findFirst: vi.fn(async ({ where }: any) => (where.id === "e9" ? target : where.id === "ceo" ? { ...target, id: "ceo", role: "CEO" } : null)) },
    email: { findMany: vi.fn(async () => [{ id: "m1" }, { id: "m2" }]) },
    attachment: { findMany: vi.fn(async () => [{ storageKey: "k1" }]) },
    msiDailyReport: { findMany: vi.fn(async () => [{ storageReference: "r1" }]) },
    misSource: { count: vi.fn(async () => 2) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  },
}));
const delAtt = vi.fn(async () => undefined);
const delMsi = vi.fn(async () => 1);
vi.mock("../src/lib/attachmentStorage", () => ({ deleteAttachment: delAtt }));
vi.mock("../src/lib/msiStorage", () => ({ deleteMsiFiles: delMsi }));

const { removeEmployee } = await import("../src/services/employeeRemoval");
const admin = { companyId: "c1", employeeId: "a1", role: "ADMIN" as const };

describe("removeEmployee", () => {
  beforeEach(() => (calls.length = 0));
  it("deletes the person and everything that is theirs, keeps the audit history", async () => {
    const r = await removeEmployee(admin, "e9");
    expect(r).toEqual({ name: "Raghav", email: "raghav", emails: 2, reports: 1, misFiles: 2 });
    for (const t of ["email", "gmailAccount", "msiDailyReport", "misSource", "misDailyCheck", "misCheckEvent", "misCircleMark", "misLeave", "misEmailLog", "dailyAnalytics", "session", "aIAction"])
      expect(calls).toContain(`${t}.deleteMany`);
    expect(calls).toContain("auditLog.updateMany");
    expect(calls.indexOf("employee.delete")).toBeGreaterThan(calls.indexOf("misSource.deleteMany"));
    expect(calls.at(-1)).toBe("auditLog.create");
    expect(delAtt).toHaveBeenCalledWith("k1");
    expect(delMsi).toHaveBeenCalledWith(["r1"]);
  });
  it("refuses to remove yourself, unknown people, or someone above you", async () => {
    await expect(removeEmployee({ ...admin, employeeId: "e9" }, "e9")).rejects.toThrow(/your own account/);
    await expect(removeEmployee(admin, "nobody")).rejects.toThrow(/not found/);
    await expect(removeEmployee(admin, "ceo")).rejects.toThrow(/higher role/);
    expect(calls).toEqual([]);
  });
});
