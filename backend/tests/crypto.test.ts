import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken } from "../src/lib/crypto";

describe("crypto: encryptToken / decryptToken", () => {
  it("round-trips a plaintext token", () => {
    const plaintext = "ya29.a0AfH6SMB_example_gmail_access_token";
    const encrypted = encryptToken(plaintext);
    expect(encrypted).not.toEqual(plaintext);
    expect(decryptToken(encrypted)).toEqual(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plaintext = "same-input-token";
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toEqual(b);
    expect(decryptToken(a)).toEqual(plaintext);
    expect(decryptToken(b)).toEqual(plaintext);
  });

  it("stores as iv:authTag:ciphertext hex triplet", () => {
    const encrypted = encryptToken("x");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(/^[0-9a-f]+$/.test(p)).toBe(true));
  });

  it("throws on a malformed stored value", () => {
    expect(() => decryptToken("not-a-valid-token")).toThrow();
  });

  it("throws if the ciphertext has been tampered with", () => {
    const encrypted = encryptToken("secret");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -2)}00`;
    expect(() => decryptToken(tampered)).toThrow();
  });
});
