import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/lib/llm", () => ({ invokeLLM: vi.fn(), isGroqCoolingDown: () => false }));

import { resolveReplyClass, REPLY_CLASSES, clampThreadContent } from "../src/services/aiPipeline";

describe("clampThreadContent", () => {
  it("leaves normal-length content untouched", () => {
    const short = "Please confirm the invoice total.";
    expect(clampThreadContent(short)).toBe(short);
  });

  // Regression: a real email requested 21,306 tokens and got HTTP 413 from
  // Groq — larger than the entire 12,000 TPM allowance, so it could never
  // succeed on any retry. 413 isn't a rate-limit status, so neither the retry
  // logic nor the circuit breaker caught it; it failed silently, forever.
  it("truncates an email large enough to exceed the whole per-minute token budget", () => {
    const huge = "x".repeat(85_000); // ≈21k tokens, the size that returned 413
    const clamped = clampThreadContent(huge);

    expect(clamped.length).toBeLessThan(8_200);
    expect(clamped).toContain("truncated for length");
    // ~4 chars/token, so this must land far below the 12,000 TPM ceiling.
    expect(Math.ceil(clamped.length / 4)).toBeLessThan(3_000);
  });

  it("does not modify content sitting exactly at the limit", () => {
    const exact = "y".repeat(8_000);
    expect(clampThreadContent(exact)).toBe(exact);
  });

  it("handles empty content", () => {
    expect(clampThreadContent("")).toBe("");
  });
});

describe("resolveReplyClass", () => {
  it("accepts the canonical values verbatim", () => {
    for (const c of REPLY_CLASSES) {
      expect(resolveReplyClass(c)).toBe(c);
    }
  });

  it("normalizes casing and surrounding whitespace", () => {
    expect(resolveReplyClass("  needs_reply  ")).toBe("NEEDS_REPLY");
    expect(resolveReplyClass("Informational")).toBe("INFORMATIONAL");
  });

  it("maps common model phrasings onto the taxonomy", () => {
    expect(resolveReplyClass("acknowledgement")).toBe("ACKNOWLEDGMENT"); // British spelling
    expect(resolveReplyClass("thanks")).toBe("ACKNOWLEDGMENT");
    expect(resolveReplyClass("FYI")).toBe("INFORMATIONAL");
    expect(resolveReplyClass("notification")).toBe("AUTOMATED");
    expect(resolveReplyClass("no-reply")).toBe("AUTOMATED");
    expect(resolveReplyClass("needs reply")).toBe("NEEDS_REPLY");
  });

  // This is the safety property of the whole feature: any failure to
  // understand the model must fail toward "this needs a reply", never toward
  // hiding an email from the employee's Unreplied list or the admin's Pending
  // count.
  it("falls back to NEEDS_REPLY for unrecognized values", () => {
    expect(resolveReplyClass("banana")).toBe("NEEDS_REPLY");
    expect(resolveReplyClass("")).toBe("NEEDS_REPLY");
  });

  it("falls back to NEEDS_REPLY for non-string input", () => {
    expect(resolveReplyClass(undefined)).toBe("NEEDS_REPLY");
    expect(resolveReplyClass(null)).toBe("NEEDS_REPLY");
    expect(resolveReplyClass(42)).toBe("NEEDS_REPLY");
    expect(resolveReplyClass({})).toBe("NEEDS_REPLY");
  });
});
