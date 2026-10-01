import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const { splitImportName, docGuid, matchExistingStaff } = await import("../src/services/misService");

describe("splitImportName", () => {
  it.each([
    ["Anjali Jha (MF MIS)", "ANJALI JHA", "MF MIS"],
    ["BHUPINDER SINGH (PAYIN PAY OUT)", "BHUPINDER SINGH", "PAYIN PAY OUT"],
    ["PRAHALAD GUPTA (226)", "PRAHALAD GUPTA", "MIS"],
    ["SOHAN LAL ", "SOHAN LAL", "MIS"],
    ["Mamta Arora (New A/C MIS)", "MAMTA ARORA", "New A/C MIS"],
  ])("%s", (raw, person, label) => {
    expect(splitImportName(raw)).toEqual({ person, label });
  });
});

describe("docGuid", () => {
  it("reads the sourcedoc id so the same file pasted twice is spotted", () => {
    const url =
      "https://x-my.sharepoint.com/:x:/r/personal/a_b_com/_layouts/15/Doc.aspx?sourcedoc=%7BF1E0FC86-436B-426D-8925-A6DAC163AA6F%7D&file=A.xlsx";
    expect(docGuid(url)).toBe("f1e0fc86-436b-426d-8925-a6dac163aa6f");
    expect(docGuid("https://x.sharepoint.com/:x:/g/abc")).toBeNull();
  });
});

describe("matchExistingStaff", () => {
  const staff = [{ email: "anjali" }, { email: "ashok kumar" }, { email: "gurmeet" }, { email: "manoj kapoor" }];
  it("matches the exact login", () => expect(matchExistingStaff(staff, "ASHOK KUMAR")?.email).toBe("ashok kumar"));
  it("matches a first-name login", () => expect(matchExistingStaff(staff, "ANJALI JHA")?.email).toBe("anjali"));
  it("does not match a different person with the same first name", () =>
    expect(matchExistingStaff(staff, "MANOJ GOYAL")).toBeNull());
  it("does not match when unsure", () => expect(matchExistingStaff([{ email: "a" }, { email: "a b" }], "A B C")).toBeNull());
});
