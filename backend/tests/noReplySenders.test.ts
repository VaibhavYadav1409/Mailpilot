import { describe, it, expect } from "vitest";
import { isNoReplySender, normalizeAddress } from "../src/services/noReplySenders";

describe("isNoReplySender", () => {
  it("matches the configured automated senders", () => {
    for (const a of [
      "alert@icici.bank.in",
      "eazypay@icici.bank.in",
      "noreply@nsdl.com",
      "epass@nsdl.com",
      "evoting@nsdl.com",
      "nsdl@nsdl.com",
    ]) {
      expect(isNoReplySender(a)).toBe(true);
    }
  });

  it("is case-insensitive and handles display-name form", () => {
    expect(isNoReplySender("NSDL Alerts <NoReply@NSDL.com>")).toBe(true);
  });

  it("matches generic automated local-parts on any domain", () => {
    expect(isNoReplySender("no-reply@example.com")).toBe(true);
    expect(isNoReplySender("donotreply@example.com")).toBe(true);
  });

  it("does not match real people", () => {
    expect(isNoReplySender("chairman@farsightshares.com")).toBe(false);
    expect(isNoReplySender("support@symphonyfintech.com")).toBe(false);
    expect(isNoReplySender(null)).toBe(false);
    expect(isNoReplySender("not-an-address")).toBe(false);
  });

  it("normalizes addresses", () => {
    expect(normalizeAddress("A B <a@b.com>")).toBe("a@b.com");
  });
});
