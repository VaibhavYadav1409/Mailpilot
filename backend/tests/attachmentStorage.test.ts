import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeAttachment, readAttachment, makeStorageKey } from "../src/lib/attachmentStorage";

const ATTACHMENTS_DIR = path.resolve(process.cwd(), "generated-attachments");

describe("attachmentStorage (local driver)", () => {
  it("writes and reads back binary attachment bytes by storage key", async () => {
    const key = makeStorageKey("email-123", 0, "invoice.pdf");
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]); // arbitrary binary, not valid utf-8
    await writeAttachment(key, bytes, "application/pdf");
    const readBack = await readAttachment(key);
    expect(readBack.equals(bytes)).toBe(true);
  });

  it("keeps a traversal-attempt filename confined to its own storage path (no directory escape)", () => {
    const key = makeStorageKey("email-1", 2, "../../etc/passwd");
    expect(key.startsWith("email-1/2-")).toBe(true);
    // The dangerous part is "../" as a path *separator* sequence, not the
    // literal characters "..": slashes are stripped, so what's left is a
    // single safe path segment even though it still contains dots.
    const resolved = path.resolve("/base", key);
    expect(resolved.startsWith(path.resolve("/base") + path.sep) || resolved === path.resolve("/base")).toBe(true);
  });

  it("rejects reading an attachment that was never written", async () => {
    await expect(readAttachment("does-not-exist/0-missing.txt")).rejects.toThrow();
  });

  afterAll(async () => {
    await fs.rm(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
});
