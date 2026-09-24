import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";

// File storage for MSI Daily Work Reports.
//
// Same "one seam, swappable driver" shape as attachmentStorage.ts and
// reportStorage.ts, but the DEFAULT is different on purpose:
//
//   MSI_STORAGE_DRIVER=db     (default) bytes live in Postgres, in the
//                             MsiReportFile table. Render's free tier has an
//                             ephemeral filesystem — anything written to local
//                             disk is lost on every redeploy, restart and
//                             spin-down, and free instances can't attach a
//                             persistent disk. The CEO must still be able to
//                             download a report two days later, so the bytes go
//                             into the database MailPilot already has. No new
//                             service, no new credentials. Files are capped
//                             (MSI_MAX_FILE_MB) and auto-deleted after 2 days,
//                             so the footprint stays small on Aiven's 1 GB plan.
//   MSI_STORAGE_DRIVER=local  bytes on local disk under ./generated-msi-reports.
//                             Only for dev or a host with a persistent disk.
//
// Keys are always server-generated (makeMsiStorageKey) and never include the
// user's filename, so a hostile filename can't influence where bytes land.
// Keys are never sent to the client — downloads go through authenticated
// backend routes that look the key up from the DB row.

const LOCAL_DIR = path.resolve(process.cwd(), "generated-msi-reports");
const KEY_PATTERN = /^msi\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

export type MsiStorageDriver = "db" | "local";

export function msiStorageDriver(): MsiStorageDriver {
  return (process.env.MSI_STORAGE_DRIVER ?? "db").toLowerCase() === "local" ? "local" : "db";
}

/** New opaque storage key for one uploaded file. Every upload (including an update) gets a fresh key. */
export function makeMsiStorageKey(companyId: string): string {
  return `msi/${companyId}/${randomUUID()}`;
}

function assertValidKey(key: string) {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid MSI storage key");
}

/** Resolves a key to a path strictly inside LOCAL_DIR (defence in depth on top of KEY_PATTERN). */
function localPath(key: string): string {
  assertValidKey(key);
  const resolved = path.resolve(LOCAL_DIR, key);
  if (!resolved.startsWith(LOCAL_DIR + path.sep)) throw new Error("Invalid MSI storage key");
  return resolved;
}

export async function putMsiFile(key: string, data: Buffer): Promise<void> {
  assertValidKey(key);
  if (msiStorageDriver() === "local") {
    const dest = localPath(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    return;
  }
  // Copy into a plain Uint8Array (Prisma Bytes type); cheap at MSI file sizes.
  await prisma.msiReportFile.create({ data: { storageKey: key, data: new Uint8Array(data) } });
}

/** Returns the file's bytes, or null if it no longer exists (already purged). */
export async function getMsiFile(key: string): Promise<Buffer | null> {
  assertValidKey(key);
  if (msiStorageDriver() === "local") {
    try {
      return await fs.readFile(localPath(key));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }
  const row = await prisma.msiReportFile.findUnique({ where: { storageKey: key }, select: { data: true } });
  return row ? Buffer.from(row.data) : null;
}

/** Deletes files by key. Idempotent: missing files count as already deleted. Returns how many were removed. */
export async function deleteMsiFiles(keys: string[]): Promise<number> {
  const valid = keys.filter((k) => KEY_PATTERN.test(k));
  if (valid.length === 0) return 0;
  if (msiStorageDriver() === "local") {
    let removed = 0;
    for (const key of valid) {
      try {
        await fs.unlink(localPath(key));
        removed++;
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
    return removed;
  }
  const result = await prisma.msiReportFile.deleteMany({ where: { storageKey: { in: valid } } });
  return result.count;
}

/**
 * Removes stored files that no MsiDailyReport points at any more — e.g. a
 * crash between writing the bytes and inserting the row. Only files older than
 * `olderThan` are touched so an upload that is mid-flight is never swept.
 * Only ever touches MSI storage (MsiReportFile / generated-msi-reports).
 */
export async function sweepOrphanMsiFiles(liveKeys: Set<string>, olderThan: Date): Promise<number> {
  if (msiStorageDriver() === "local") {
    let removed = 0;
    let companies: string[] = [];
    try {
      companies = await fs.readdir(path.join(LOCAL_DIR, "msi"));
    } catch {
      return 0;
    }
    for (const company of companies) {
      const dir = path.join(LOCAL_DIR, "msi", company);
      let files: string[] = [];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const key = `msi/${company}/${file}`;
        if (!KEY_PATTERN.test(key) || liveKeys.has(key)) continue;
        const full = localPath(key);
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.mtime < olderThan) {
          await fs.unlink(full).catch(() => undefined);
          removed++;
        }
      }
    }
    return removed;
  }
  const result = await prisma.msiReportFile.deleteMany({
    where: { createdAt: { lt: olderThan }, storageKey: { notIn: [...liveKeys] } },
  });
  return result.count;
}
