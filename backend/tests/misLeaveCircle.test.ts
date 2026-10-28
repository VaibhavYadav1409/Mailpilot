import { describe, expect, it, vi } from "vitest";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const state = {
  satOff: false,
  extraSat: false,
  leaves: [] as any[],
  marks: [
    { employeeId: "e1", date: D("2026-10-05"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null },
    { employeeId: "e1", date: D("2026-10-06"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null },
    { employeeId: "e1", date: D("2026-10-07"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null },
  ],
};
vi.mock("../src/lib/db", () => ({
  prisma: {
    employee: { findMany: async () => [{ id: "e1", firstName: "Mamta", lastName: "", email: "mamta", misSaturdaysOff: state.satOff, misExtraSaturdayOff: state.extraSat, _count: { misSources: 1 } }] },
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
  it("without leave: 3 red circles — no deduction yet (5 = 1 day's salary)", async () => {
    state.leaves = [];
    const m = await c.getCircleMonth("co", "2026-10", { now });
    expect(m.rows[0].summary).toMatchObject({ circles: 3, deductionDays: 0, untilNextDeduction: 2 });
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

describe("every Saturday off for one person", () => {
  it("turns a red circle on a working Saturday into SO (also for past days)", async () => {
    state.leaves = [];
    state.marks = [
      { employeeId: "e1", date: D("2026-10-03"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null }, // 1st Saturday
      { employeeId: "e1", date: D("2026-10-05"), code: "CM", source: "AUTO", note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null },
    ];
    state.satOff = false;
    expect((await c.getCircleMonth("co", "2026-10", { now })).rows[0].summary.circles).toBe(2);
    state.satOff = true;
    const r = (await c.getCircleMonth("co", "2026-10", { now })).rows[0];
    expect(r.cells["2026-10-03"]).toMatchObject({ code: "SO", source: "CALENDAR" });
    expect(r.cells["2026-10-05"].code).toBe("CM");
    expect(r.summary.circles).toBe(1);
    state.satOff = false;
  });
});

describe("2 Saturdays off a month (2nd Saturday + one more)", () => {
  const cm = (d: string, source = "AUTO", code = "CM") => ({ employeeId: "e1", date: D(d), code, source, note: null, autoCode: "CM", reason: "Not filled", updatedById: null, evidence: null });
  it("the first other Saturday whose MIS wasn't done is SO; the next one stays a red circle", async () => {
    state.leaves = [];
    state.marks = [cm("2026-10-03"), cm("2026-10-17"), cm("2026-10-05")]; // 1st and 3rd Saturday + a Monday
    state.extraSat = true;
    const r = (await c.getCircleMonth("co", "2026-10", { now: new Date("2026-10-27T08:00:00Z") })).rows[0];
    expect(r.cells["2026-10-03"]).toMatchObject({ code: "SO", source: "CALENDAR", autoCode: "CM", reason: c.EXTRA_SATURDAY_REASON });
    expect(r.cells["2026-10-10"].code).toBe("SSO"); // the 2nd Saturday, as for everyone
    expect(r.cells["2026-10-17"].code).toBe("CM");
    expect(r.summary.circles).toBe(2);
  });
  it("a Saturday the person filled doesn't use it up", async () => {
    state.marks = [cm("2026-10-03", "AUTO", "NC"), cm("2026-10-17")];
    const r = (await c.getCircleMonth("co", "2026-10", { now: new Date("2026-10-27T08:00:00Z") })).rows[0];
    expect(r.cells["2026-10-17"].code).toBe("SO");
    expect(r.summary.circles).toBe(0);
  });
  it("a Saturday HR marked SO is the extra one", async () => {
    state.marks = [cm("2026-10-24", "MANUAL", "SO"), cm("2026-10-03")];
    const r = (await c.getCircleMonth("co", "2026-10", { now: new Date("2026-10-27T08:00:00Z") })).rows[0];
    expect(r.cells["2026-10-03"].code).toBe("CM");
    expect(r.cells["2026-10-24"]).toMatchObject({ code: "SO", source: "MANUAL" });
    state.extraSat = false;
  });
});
