import { describe, expect, it, vi } from "vitest";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const state = {
  leaves: [] as any[],
  marks: [
    { employeeId: "e1", date: D("2026-10-05"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null },
    { employeeId: "e1", date: D("2026-10-06"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null },
    { employeeId: "e1", date: D("2026-10-07"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null },
  ],
};
vi.mock("../src/lib/db", () => ({
  prisma: {
    employee: { findMany: async () => [{ id: "e1", firstName: "Mamta", lastName: "", email: "mamta", _count: { misSources: 1 } }] },
    misCircleMark: { findMany: async () => state.marks },
    misHoliday: { findMany: async () => [] },
    misSource: { findMany: async () => [] },
    misLeave: {
      findMany: async ({ where }: any) =>
        state.leaves.filter((l) => l.status === "APPROVED" && l.fromDate <= where.fromDate.lte && l.toDate >= where.toDate.gte),
    },
  },
}));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const c = await import("../src/services/misCircle");
const now = new Date("2026-10-12T08:00:00Z");

describe("leave records change the Circle Report (also for past days)", () => {
  it("without leave: 3 red circles = 1 day's salary", async () => {
    state.leaves = [];
    const m = await c.getCircleMonth("co", "2026-10", { now });
    expect(m.rows[0].summary).toMatchObject({ circles: 3, deductionDays: 1 });
  });
  it("approved planned leave on 6–7 Oct turns those days into OL — 1 circle, no deduction", async () => {
    state.leaves = [
      { id: "l1", employeeId: "e1", fromDate: D("2026-10-06"), toDate: D("2026-10-07"), type: "PLANNED", status: "APPROVED", submittedAt: new Date("2026-10-01T05:00:00Z"), source: "FORM", reason: "Wedding" },
    ];
    const m = await c.getCircleMonth("co", "2026-10", { now });
    const r = m.rows[0];
    expect(r.cells["2026-10-06"]).toMatchObject({ code: "OL", source: "LEAVE", autoCode: "CM" });
    expect(r.cells["2026-10-06"].reason).toBe("Planned leave Tue 6 Oct – Wed 7 Oct — asked on Thu 1 Oct: Wedding.");
    expect(r.cells["2026-10-05"].code).toBe("CM");
    expect(r.summary).toMatchObject({ circles: 1, deductionDays: 0 });
  });
  it("emergency leave shows EL; a rejected leave changes nothing", async () => {
    state.leaves = [
      { id: "l2", employeeId: "e1", fromDate: D("2026-10-05"), toDate: D("2026-10-05"), type: "EMERGENCY", status: "APPROVED", submittedAt: new Date("2026-10-06T05:00:00Z"), source: "FORM", reason: null },
      { id: "l3", employeeId: "e1", fromDate: D("2026-10-07"), toDate: D("2026-10-07"), type: "PLANNED", status: "REJECTED", submittedAt: null, source: "MANUAL", reason: null },
    ];
    const m = await c.getCircleMonth("co", "2026-10", { now });
    expect(m.rows[0].cells["2026-10-05"].code).toBe("EL");
    expect(m.rows[0].cells["2026-10-07"].code).toBe("CM");
    expect(m.rows[0].summary.circles).toBe(2);
  });
  it("an HR mark on the Circle Report still wins over a leave record", async () => {
    state.leaves = [{ id: "l4", employeeId: "e1", fromDate: D("2026-10-05"), toDate: D("2026-10-05"), type: "PLANNED", status: "APPROVED", submittedAt: null, source: "MANUAL", reason: null }];
    state.marks = [{ ...state.marks[0], code: "CM", source: "MANUAL", note: "Leave not approved by manager" }];
    const m = await c.getCircleMonth("co", "2026-10", { now });
    expect(m.rows[0].cells["2026-10-05"]).toMatchObject({ code: "CM", source: "MANUAL" });
  });
});
