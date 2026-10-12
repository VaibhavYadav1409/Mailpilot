import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const L = await import("../src/services/misLeave");

describe("leave form columns", () => {
  it("understands typical Google Form titles", () => {
    expect(
      L.mapHeaders(["Timestamp", "Email Address", "Employee Name", "Department", "Leave From", "Leave To", "Type of Leave", "Reason for Leave"]),
    ).toEqual({ timestamp: "Timestamp", email: "Email Address", name: "Employee Name", from: "Leave From", to: "Leave To", kind: "Type of Leave", reason: "Reason for Leave" });
    expect(L.mapHeaders(["Timestamp", "Name", "Date of Leave", "No. of Days", "Purpose"])).toEqual({
      timestamp: "Timestamp",
      name: "Name",
      from: "Date of Leave",
      days: "No. of Days",
      reason: "Purpose",
    });
    expect(L.mapHeaders(["Timestamp", "Name", "Start Date", "End Date", "Status"])).toMatchObject({ from: "Start Date", to: "End Date", status: "Status" });
  });
});

describe("reading a response", () => {
  const map = L.mapHeaders(["Timestamp", "Email Address", "Employee Name", "Leave From", "Leave To", "Reason for Leave"]);
  it("reads the script's dates and the timestamp in India time", () => {
    const p = L.parseLeaveRow(
      { Timestamp: "2026-10-12T14:05:00", "Email Address": "Mamta@X.com", "Employee Name": "Mamta", "Leave From": "2026-10-15T00:00:00", "Leave To": "2026-10-16T00:00:00", "Reason for Leave": "Family function" },
      map,
    );
    expect(p).toMatchObject({ personName: "Mamta", email: "mamta@x.com", from: "2026-10-15", to: "2026-10-16", reason: "Family function", rejected: false });
    expect(!("error" in p) && p.submittedAt?.toISOString()).toBe("2026-10-12T08:35:00.000Z");
  });
  it("reads typed dd/mm/yyyy dates and a days count", () => {
    const m2 = L.mapHeaders(["Timestamp", "Name", "Date of Leave", "No. of Days"]);
    const p = L.parseLeaveRow({ Timestamp: "12/10/2026 14:05:00", Name: "Joseph", "Date of Leave": "20/10/2026", "No. of Days": "3" }, m2);
    expect(p).toMatchObject({ from: "2026-10-20", to: "2026-10-22" });
  });
  it("one date = one day; missing date = clear error", () => {
    const m3 = L.mapHeaders(["Name", "Leave Date"]);
    expect(L.parseLeaveRow({ Name: "Diya", "Leave Date": "2026-10-21" }, m3)).toMatchObject({ from: "2026-10-21", to: "2026-10-21" });
    expect(L.parseLeaveRow({ Name: "Diya", "Leave Date": "" }, m3)).toEqual({ error: "Couldn't read the leave date for Diya." });
  });
  it("respects a Rejected status column", () => {
    const m4 = L.mapHeaders(["Name", "From", "To", "Status"]);
    expect(L.parseLeaveRow({ Name: "A", From: "2026-10-20", To: "2026-10-20", Status: "Rejected" }, m4)).toMatchObject({ rejected: true });
  });
});

describe("planned vs emergency (2 days' notice)", () => {
  it.each([
    ["2026-10-12", "2026-10-15", "PLANNED"], // 3 days before
    ["2026-10-13", "2026-10-15", "PLANNED"], // exactly 2 days before
    ["2026-10-14", "2026-10-15", "EMERGENCY"], // 1 day before
    ["2026-10-15", "2026-10-15", "EMERGENCY"], // same day
    ["2026-10-17", "2026-10-15", "EMERGENCY"], // after the leave
  ])("asked %s for %s -> %s", (asked, from, want) => {
    expect(L.classifyLeave(asked, from, 2)).toBe(want);
  });
  it("counts working days", async () => {
    const w = await import("../src/services/workCalendar");
    expect(L.workingDaysIn("2026-10-09", "2026-10-13", w.DEFAULT_CALENDAR)).toBe(3); // Fri, (Sat 10 = 2nd Sat, Sun), Mon, Tue
    expect(L.expandDates("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
  it("the script carries the link and the tab", () => {
    const s = L.formScript("https://x.example/api/mis/leaves/form/abc", "1231513219");
    expect(s).toContain('const MAILPILOT_URL = "https://x.example/api/mis/leaves/form/abc";');
    expect(s).toContain("const RESPONSES_TAB_ID = 1231513219;");
    expect(s).toContain("onFormSubmit()");
  });
});
