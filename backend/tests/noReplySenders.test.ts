import { describe, it, expect } from "vitest";
import { isNoReplySender, isNoReplyPair, isOtpEmail, normalizeAddress } from "../src/services/noReplySenders";

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

  it("matches a configured pair in both directions only", () => {
    const global = "global@farsightshares.com";
    const newacc = "newaccount@farsightshares.com";
    expect(isNoReplyPair(global, [newacc])).toBe(true);
    expect(isNoReplyPair(newacc, [global])).toBe(true);
    expect(isNoReplyPair(newacc, ["someone@else.com", global])).toBe(true);
    // Same senders, different recipient — still ordinary mail.
    expect(isNoReplyPair(global, ["client@else.com"])).toBe(false);
    expect(isNoReplyPair(global, [])).toBe(false);
    // The pair members are not blanket no-reply senders.
    expect(isNoReplySender(global)).toBe(false);
    expect(isNoReplySender(newacc)).toBe(false);
  });

  it("matches OTP mail by subject", () => {
    expect(isOtpEmail("Your OTP for login")).toBe(true);
    expect(isOtpEmail("One Time Password - NSDL")).toBe(true);
    expect(isOtpEmail("Verification code: 483920")).toBe(true);
    expect(isOtpEmail("Your security code")).toBe(true);
    expect(isOtpEmail("Two-factor authentication")).toBe(true);
  });

  it("matches OTP mail by body when the subject is bland", () => {
    expect(isOtpEmail("Notification", "483920 is your OTP. Do not share it with anyone.")).toBe(true);
    expect(isOtpEmail("Hello", "Your verification code is 123456, valid for 10 minutes.")).toBe(true);
  });

  it("does not match ordinary mail that merely mentions codes", () => {
    expect(isOtpEmail("Re: the promo code for the campaign")).toBe(false);
    expect(isOtpEmail("Please verify these figures", "Can you confirm the client code in row 4?")).toBe(false);
    expect(isOtpEmail("Update on CSCRF Compliance and STQC Certification Process.")).toBe(false);
    expect(isOtpEmail(null, null)).toBe(false);
  });

  it("normalizes addresses", () => {
    expect(normalizeAddress("A B <a@b.com>")).toBe("a@b.com");
  });
});
