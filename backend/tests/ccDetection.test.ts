import { describe, it, expect, vi } from "vitest";

// emailSync.ts pulls in the Prisma client and the LLM/attachment stack at
// import time; the two functions under test here are pure header parsing and
// don't touch any of it, so those modules are stubbed out rather than
// requiring a live DB or a regenerated Prisma client.
vi.mock("../src/lib/db", () => ({ prisma: {} }));

import { parseAddressList, computeIsCc, computeIsSecondaryTo } from "../src/services/emailSync";

describe("parseAddressList", () => {
  it("extracts addresses from angle-bracket form and lowercases them", () => {
    expect(parseAddressList("Vaibhav Yadav <Vaibhav@Example.com>")).toEqual(["vaibhav@example.com"]);
  });

  it("splits multiple recipients", () => {
    expect(parseAddressList("a@x.com, b@y.com, c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  // The regression this parser exists for: naive comma splitting mangles
  // "Last, First" display names, which are extremely common on Cc lines.
  it("does not split on commas inside quoted display names", () => {
    const raw = '"Yadav, Vaibhav" <v@example.com>, ops@example.com';
    expect(parseAddressList(raw)).toEqual(["v@example.com", "ops@example.com"]);
  });

  it("handles bare addresses without angle brackets", () => {
    expect(parseAddressList("plain@example.com")).toEqual(["plain@example.com"]);
  });

  it("returns an empty array for null/undefined/empty headers", () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });

  it("drops entries that aren't addresses", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  });
});

describe("computeIsCc", () => {
  const owner = "me@company.com";

  it("is true when the owner is only in Cc", () => {
    expect(computeIsCc(owner, ["someone@else.com"], [owner])).toBe(true);
  });

  it("is false when the owner is a direct recipient, even if also in Cc", () => {
    // Addressed directly is addressed directly — being duplicated onto Cc
    // shouldn't demote the email into the "just copied in" view.
    expect(computeIsCc(owner, [owner], [owner])).toBe(false);
  });

  it("is false when the owner is in neither list (bcc / alias / mailing list)", () => {
    // "Not visibly addressed" is a different claim from "was CC'd" and must
    // not land in the CC view.
    expect(computeIsCc(owner, ["a@b.com"], ["c@d.com"])).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(computeIsCc("Me@Company.com", ["other@x.com"], ["ME@COMPANY.COM"])).toBe(true);
  });

  it("is false when the owner address is empty", () => {
    expect(computeIsCc("", ["a@b.com"], ["c@d.com"])).toBe(false);
  });
});

describe("computeIsSecondaryTo — only the first To address has to reply", () => {
  const to = ["risk_mgm@farsightshares.com", "accounts@farsightshares.com"];
  it("the first To address must reply", () => {
    expect(computeIsSecondaryTo("risk_mgm@farsightshares.com", to)).toBe(false);
  });
  it("a later To address does not (case and spaces ignored)", () => {
    expect(computeIsSecondaryTo("accounts@farsightshares.com", to)).toBe(true);
    expect(computeIsSecondaryTo(" Accounts@FarsightShares.com", ["a@b.com", "ACCOUNTS@farsightshares.com "])).toBe(true);
  });
  it("alone in To, or not visibly in To (bcc / alias): unchanged", () => {
    expect(computeIsSecondaryTo("accounts@farsightshares.com", ["accounts@farsightshares.com"])).toBe(false);
    expect(computeIsSecondaryTo("accounts@farsightshares.com", ["list@farsightshares.com", "x@y.com"])).toBe(false);
    expect(computeIsSecondaryTo("", to)).toBe(false);
  });
});
