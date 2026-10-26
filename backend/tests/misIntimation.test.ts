import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));
process.env.MAIL_DAY_TIMEZONE ??= "Asia/Kolkata";

const t = await import("../src/services/misIntimation");
const { matchPersonByName } = await import("../src/services/misEmail");

// Staff as they might be named in MailPilot.
const staff = ["Kumud Jha", "Gurmeet Singh", "Diya", "Joji Jopesh", "Mahender Singh", "Shilpa Saini", "Aman Nair", "Manoj Goyal", "Sohan Lal"].map((name, i) => ({
  employeeId: `e${i}`,
  name,
  email: name.toLowerCase(),
}));
const match = (n: string) => {
  const p = matchPersonByName(staff, n);
  return p ? { employeeId: p.employeeId, name: p.name } : null;
};
const id = (name: string) => staff.find((s) => s.name === name)!.employeeId;

// What the three screenshots say (cells copied as written).
const r23: import("../src/services/misIntimation").ReadReport = {
  title: "Intimation Report 23.10.2026",
  intimations: [{ name: "Kumud Jha", type: "Intimation of late", status: "Yes", reason: "NIL", replacement: "Ms. Shilpa Mam" }],
  advance: [
    { name: "Mr. Gurmeet Singh", formDate: "21.10.2026", leaveDates: "24.10.2026 to 26.10.2026", status: "Yes", reason: "Sukhmani sahib path in punjab relative", replacement: "Manoj Goyal and Sohan ji" },
    { name: "Ms. Diya", formDate: "23.10.2026", leaveDates: "26.10.2026 and 27.10.2026", status: "Yes", reason: "Exam", replacement: "Ms. Anjali Jha" },
  ],
};
const r24: import("../src/services/misIntimation").ReadReport = {
  title: "Intimation Report 24.10.2026",
  intimations: [
    { name: "Mr. Joji Jopesh", type: "Intimation of late", status: "Yes", reason: "NIL", replacement: "Mr. Bhupender Ji" },
    { name: "Mr. Gurmeet Singh", type: "Intimation of Leave for 24.10.2026 to 26.10.2026", status: "Yes", reason: "Sukhmani sahib path in punjab relative", replacement: "Manoj Goyal and Sohan ji" },
    { name: "Mr. Mahender Ji", type: "Saturday off", status: "Yes", reason: "NIl", replacement: "Mr. Prahlad Ji" },
    { name: "Mrs. Shilpa Mam", type: "Intimation of late", status: "Yes", reason: "NIl", replacement: "Mr. Kumud Jha Ji" },
  ],
  advance: [{ name: "Ms. Diya", formDate: "23.10.2026", leaveDates: "26.10.2026 and 27.10.2026", status: "Yes", reason: "Exam", replacement: "Ms. Anjali Jha" }],
};
const r26: import("../src/services/misIntimation").ReadReport = {
  title: "Intimation Report 26.10.2026",
  intimations: [
    { name: "Mr. Gurmeet Singh", type: "Intimation of Leave", status: "24.10.2026 to 26.10.2026", reason: "Sukhmani sahib path in punjab relative", replacement: "Manoj Goyal and Sohan ji" },
    { name: "Mr. Aman Nair", type: "No Intimation", status: "Nil", reason: "Nil", replacement: "Mr. Sohan" },
  ],
  advance: [{ name: "Ms. Diya", formDate: "23.10.2026", leaveDates: "27.10.2026", status: "Yes", reason: "Exam", replacement: "Ms. Anjali Jha" }],
};

/** Mimics the database across uploads (leave recorded by earlier reports). */
function run(reports: [string, typeof r23][]) {
  const recorded: { employeeId: string; type: string; from: string; to: string; advance: boolean }[] = [];
  const results: Record<string, ReturnType<typeof t.planReport>> = {};
  for (const [date, read] of reports) {
    const covered = (emp: string, from: string, to: string, section: string) =>
      recorded.some((l) => l.employeeId === emp && l.from <= from && l.to >= to && (section === "INTIMATION" || l.advance));
    const plan = t.planReport(read, date, 2, match, covered);
    for (const row of plan)
      for (const l of row.leave) {
        if (row.section === "ADVANCE") for (let i = recorded.length - 1; i >= 0; i--) if (recorded[i].employeeId === row.employeeId && !recorded[i].advance && recorded[i].from >= l.from && recorded[i].to <= l.to) recorded.splice(i, 1);
        recorded.push({ employeeId: row.employeeId!, type: l.type, from: l.from, to: l.to, advance: row.section === "ADVANCE" });
      }
    results[date] = plan;
  }
  return { recorded, results };
}

describe("reading the cells", () => {
  it("dates are day-first; ranges and 'and' lists", () => {
    expect(t.datesIn("24.10.2026 to 26.10.2026")).toEqual(["2026-10-24", "2026-10-26"]);
    expect(t.periodsIn("24.10.2026 to 26.10.2026")).toEqual([{ from: "2026-10-24", to: "2026-10-26" }]);
    expect(t.periodsIn("26.10.2026 and 27.10.2026")).toEqual([{ from: "2026-10-26", to: "2026-10-27" }]);
    expect(t.periodsIn("01.11.2026 and 05.11.2026")).toEqual([{ from: "2026-11-01", to: "2026-11-01" }, { from: "2026-11-05", to: "2026-11-05" }]);
    expect(t.datesIn("31.02.2026 Nil")).toEqual([]);
    expect(t.datesIn("5/11/26")).toEqual(["2026-11-05"]);
  });
  it("names without Mr./Ms./Ji/Mam match MailPilot staff", () => {
    expect(t.cleanName("Mrs. Shilpa Mam")).toBe("Shilpa");
    expect(t.cleanName("Mr. Mahender Ji")).toBe("Mahender");
    expect(match(t.cleanName("Mr. Gurmeet Singh"))?.name).toBe("Gurmeet Singh");
    expect(match(t.cleanName("Mrs. Shilpa Mam"))?.name).toBe("Shilpa Saini");
    expect(match(t.cleanName("Mr. Mahender Ji"))?.name).toBe("Mahender Singh");
  });
  it("what each intimation means", () => {
    expect(t.kindOf("Intimation of late Yes")).toBe("LATE");
    expect(t.kindOf("Saturday off Yes")).toBe("SATURDAY_OFF");
    expect(t.kindOf("No Intimation Nil")).toBe("ABSENT");
    expect(t.kindOf("Intimation of Leave for 24.10.2026 to 26.10.2026")).toBe("LEAVE");
    expect(t.kindOf("Half Day")).toBe("HALF_DAY");
    expect(t.kindOf("WFH")).toBe("WFH");
  });
  it("the AI answer is parsed even with thinking text around it", () => {
    const r = t.parseReadReport('<think>looking…</think>```json\n{"title":"Intimation Report 23.10.2026","intimations":[{"name":"Kumud  Jha","type":"Intimation of\\nlate"},{"name":""}],"advance":[]}\n```');
    expect(r.intimations).toEqual([{ name: "Kumud Jha", type: "Intimation of late", status: "", reason: "", replacement: "" }]);
    expect(() => t.parseReadReport("sorry")).toThrow(/clear screenshot/);
  });
});

describe("your three reports (23, 24, 26 Oct)", () => {
  const { recorded, results } = run([["2026-10-23", r23], ["2026-10-24", r24], ["2026-10-26", r26]]);
  it("records exactly: Gurmeet planned 24–26, Diya planned 26–27, Mahender Saturday off 24, Aman absent 26", () => {
    expect(recorded.map(({ advance, ...l }) => l)).toEqual([
      { employeeId: id("Gurmeet Singh"), type: "PLANNED", from: "2026-10-24", to: "2026-10-26" },
      { employeeId: id("Diya"), type: "PLANNED", from: "2026-10-26", to: "2026-10-27" },
      { employeeId: id("Mahender Singh"), type: "SATURDAY_OFF", from: "2026-10-24", to: "2026-10-24" },
      { employeeId: id("Aman Nair"), type: "ABSENT", from: "2026-10-26", to: "2026-10-26" },
    ]);
  });
  it("late intimations are recorded only; repeats say 'already recorded'", () => {
    expect(results["2026-10-23"].map((r) => r.result)).toEqual(["Planned leave Sat 24 Oct – Mon 26 Oct", "Planned leave Mon 26 Oct – Tue 27 Oct", "Late — recorded (MIS still needed)"]);
    expect(results["2026-10-24"].find((r) => r.name === "Mr. Gurmeet Singh" && r.section === "INTIMATION")!.result).toBe("Leave Sat 24 Oct – Mon 26 Oct — already recorded");
    expect(results["2026-10-26"].map((r) => r.result)).toEqual(["Leave Tue 27 Oct — already recorded", "Leave Sat 24 Oct – Mon 26 Oct — already recorded", "Absent Mon 26 Oct (no intimation)"]);
  });
  it("order doesn't matter: a later report first, then the advance application → still Planned", () => {
    const { recorded } = run([["2026-10-24", r24], ["2026-10-23", r23]]);
    const g = recorded.filter((l) => l.employeeId === id("Gurmeet Singh"));
    expect(g.map(({ advance, ...l }) => l)).toEqual([{ employeeId: id("Gurmeet Singh"), type: "PLANNED", from: "2026-10-24", to: "2026-10-26" }]);
  });
  it("someone not in MailPilot is reported, never guessed", () => {
    const plan = t.planReport({ title: "", intimations: [{ name: "Mr. Unknown Person", type: "Intimation of Leave", status: "Yes", reason: "", replacement: "" }], advance: [] }, "2026-10-26", 2, match, () => false);
    expect(plan[0].employeeId).toBeNull();
    expect(plan[0].leave).toEqual([]);
    expect(plan[0].result).toMatch(/person not found in MailPilot/);
  });
});
