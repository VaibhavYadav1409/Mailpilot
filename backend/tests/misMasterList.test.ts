import { describe, expect, it, vi } from "vitest";

// A tiny in-memory database for the planner.
const db = {
  employees: [] as Record<string, unknown>[],
  sources: [] as Record<string, unknown>[],
};
vi.mock("../src/lib/db", () => ({
  prisma: {
    employee: { findMany: async () => db.employees },
    misSource: { findMany: async () => db.sources },
  },
}));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const { parseMasterList, planMasterList, saturdayRuleFrom, matchPerson } = await import("../src/services/misMasterList");
const { buildWorkbook } = await import("../src/lib/xlsx");
const { readXlsx } = await import("../src/lib/xlsxRead");

const link = (guid: string, file: string) =>
  `https://example-my.sharepoint.com/:x:/r/personal/a_b_com/_layouts/15/Doc.aspx?sourcedoc=%7B${guid}%7D&file=${encodeURIComponent(file)}&action=default`;
const G1 = "11111111-1111-1111-1111-111111111111";
const G2 = "22222222-2222-2222-2222-222222222222";
const G3 = "33333333-3333-3333-3333-333333333333";
const G4 = "44444444-4444-4444-4444-444444444444";
const OLD = "99999999-9999-9999-9999-999999999999";

const file = buildWorkbook({
  styles: [{}],
  sheets: [
    {
      name: "Active Emp Links",
      rows: [
        ["Employee Name", "MIS Links", "Email Using by Employee ", "Off for employee"],
        ["Anjali Jha (Mutual Fund MIS)", link(G1, "MF MIS.xlsx"), "mutualfund@x.com\nnps@x.com", "2nd Saturday Off in every month "],
        ["Anjali Jha (NPS MIS)", link(G2, "NPS MIS.xlsx"), "mutualfund@x.com\nnps@x.com", "2nd Saturday Off in every month "],
        ["PRAHALAD GUPTA", link(G3, "Prahlad MIS.xlsx"), "bdm@y.com", "Please note that there will be 2 Saturdays off every month. 2nd Saturday + one additional Saturday"],
        ["MANOJ KAPOOR", link(G4, "MIS FAO.xlsx"), "nsetrading@y.com\u00a0", "2nd Saturday Off in every month "],
        ["Old Sheet Person", "https://docs.google.com/spreadsheets/d/abc/edit", "", ""],
        ["Vaibhav Yadav", "I have no your MIS Link ", "", ""],
      ],
    },
    { name: "Left Emp MIS Links", rows: [["", " Job Left "], ["1", "RAGHU VERMA", "https://docs.google.com/x", "Job Left"]] },
  ],
});

describe("readXlsx", () => {
  it("reads the cells back, including line breaks and non-breaking spaces", () => {
    const s = readXlsx(file);
    expect(s.map((x) => x.name)).toEqual(["Active Emp Links", "Left Emp MIS Links"]);
    expect(s[0].rows[1][2]).toBe("mutualfund@x.com\nnps@x.com");
  });
  it("rejects a file that isn't .xlsx", () => {
    expect(() => readXlsx(Buffer.from("hello"))).toThrow(/not an Excel/);
  });
});

describe("saturdayRuleFrom", () => {
  it.each([
    ["2nd Saturday Off in every month ", "SECOND"],
    ["Please note that there will be 2 Saturdays off every month. 2nd Saturday + one additional Saturday designated as off", "TWO"],
    ["Every Saturday off", "ALL"],
    ["", null],
  ])("%s", (t, want) => expect(saturdayRuleFrom(t)).toBe(want));
});

describe("matchPerson", () => {
  const s = (id: string, email: string, first: string, last = "") =>
    ({ id, email, firstName: first, lastName: last, contactEmail: null, misSaturdaysOff: false, misExtraSaturdayOff: false, misWeeklySince: null, status: "OFFLINE" });
  const staff = [s("a", "anjali", "Anjali"), s("b", "bhupinder singh", "Bhupinder", "Singh"), s("m1", "manoj goyal", "Manoj", "Goyal")];
  it("first-name login", () => expect(matchPerson(staff, "Anjali Jha (NPS MIS)")?.id).toBe("a"));
  it("small spelling difference", () => expect(matchPerson(staff, "BHUPENDER SINGH ")?.id).toBe("b"));
  it("a different person with the same first name is not matched", () => expect(matchPerson(staff, "MANOJ KAPOOR")).toBeNull());
});

describe("planMasterList", () => {
  it("shows new files, old files, emails, Saturday rules and new people", async () => {
    db.employees = [
      { id: "anj", email: "anjali", firstName: "Anjali", lastName: "", contactEmail: "mutualfund@x.com", misSaturdaysOff: true, misExtraSaturdayOff: false, misWeeklySince: null, status: "OFFLINE" },
      { id: "pra", email: "prahalad gupta", firstName: "Prahalad", lastName: "Gupta", contactEmail: "bdm@y.com", misSaturdaysOff: false, misExtraSaturdayOff: false, misWeeklySince: null, status: "OFFLINE" },
      { id: "vai", email: "info@t.com", firstName: "Vaibhav", lastName: "Yadav", contactEmail: null, misSaturdaysOff: false, misExtraSaturdayOff: false, misWeeklySince: new Date("2026-10-12"), status: "OFFLINE" },
      { id: "rag", email: "raghu verma", firstName: "Raghu", lastName: "Verma", contactEmail: null, misSaturdaysOff: false, misExtraSaturdayOff: false, misWeeklySince: null, status: "OFFLINE" },
    ];
    db.sources = [
      { id: "s1", employeeId: "anj", label: "MF", shareUrl: link(G1, "MF MIS.xlsx"), fileName: "MF MIS.xlsx" },
      { id: "s2", employeeId: "pra", label: "MIS", shareUrl: link(OLD, "Prahlad old.xlsx"), fileName: "Prahlad old.xlsx" },
      { id: "s3", employeeId: "rag", label: "MIS", shareUrl: link("88888888-8888-8888-8888-888888888888", "R.xlsx"), fileName: "R.xlsx" },
    ];
    const plan = await planMasterList("c", parseMasterList(file));
    const by = (n: string) => plan.people.find((p) => p.listName.startsWith(n))!;

    const anj = by("Anjali");
    expect(anj.lines).toEqual([2, 3]);
    expect(anj.files.map((f) => f.state)).toEqual(["already linked", "new"]);
    expect(anj.emails).toMatchObject({ list: ["mutualfund@x.com", "nps@x.com"], change: true });
    expect(anj.saturday).toMatchObject({ now: "ALL", list: "SECOND", change: false, kept: true });

    const pra = by("PRAHALAD");
    expect(pra.files[0].state).toBe("new");
    expect(pra.oldFiles.map((o) => o.id)).toEqual(["s2"]);
    expect(pra.saturday).toMatchObject({ now: "SECOND", list: "TWO", change: true });
    expect(pra.emails.change).toBe(false);

    const kap = by("MANOJ");
    expect(kap.isNew).toBe(true);
    expect(kap.emails.list).toEqual(["nsetrading@y.com"]);

    expect(by("Old Sheet").files[0]).toMatchObject({ state: "invalid", problem: expect.stringMatching(/Google Sheets/) });
    expect(by("Vaibhav").files).toEqual([]);
    expect(by("Vaibhav").notes.join()).toMatch(/Weekly reporter/);

    expect(plan.notInList.map((x) => x.employeeId)).toEqual(["rag"]);
    expect(plan.leftButActive.map((x) => x.employeeId)).toEqual(["rag"]);
    expect(plan.counts).toMatchObject({ newPeople: 1, newFiles: 3, oldFiles: 1 });
  });
});
