import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/lib/db", () => ({ prisma: {} }));

// Exercise the local driver in a throwaway cwd so nothing lands in the repo.
const originalCwd = process.cwd();
let tmp: string;
let storage: typeof import("../src/lib/msiStorage");

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "msi-storage-"));
  process.chdir(tmp);
  process.env.MSI_STORAGE_DRIVER = "local";
  vi.resetModules();
  storage = await import("../src/lib/msiStorage");
});

afterAll(async () => {
  process.chdir(originalCwd);
  delete process.env.MSI_STORAGE_DRIVER;
  await fs.rm(tmp, { recursive: true, force: true });
});

const COMPANY = "11111111-1111-1111-1111-111111111111";

describe("msiStorage (local driver)", () => {
  it("round-trips bytes under a server-generated key", async () => {
    const key = storage.makeMsiStorageKey(COMPANY);
    expect(key).toMatch(/^msi\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    await storage.putMsiFile(key, Buffer.from("hello"));
    expect((await storage.getMsiFile(key))?.toString()).toBe("hello");
    expect(await storage.deleteMsiFiles([key])).toBe(1);
    expect(await storage.getMsiFile(key)).toBeNull();
    expect(await storage.deleteMsiFiles([key])).toBe(0); // idempotent
  });

  it("refuses keys that could escape the storage folder", async () => {
    await expect(storage.putMsiFile("../../evil", Buffer.from("x"))).rejects.toThrow("Invalid MSI storage key");
    await expect(storage.getMsiFile(`msi/${COMPANY}/../../x`)).rejects.toThrow("Invalid MSI storage key");
    expect(await storage.deleteMsiFiles(["../../etc/passwd"])).toBe(0);
  });

  it("sweeps only old files with no live report", async () => {
    const live = storage.makeMsiStorageKey(COMPANY);
    const orphan = storage.makeMsiStorageKey(COMPANY);
    await storage.putMsiFile(live, Buffer.from("a"));
    await storage.putMsiFile(orphan, Buffer.from("b"));
    const future = new Date(Date.now() + 60_000);
    expect(await storage.sweepOrphanMsiFiles(new Set([live]), future)).toBe(1);
    expect(await storage.getMsiFile(live)).not.toBeNull();
    expect(await storage.getMsiFile(orphan)).toBeNull();
  });
});
