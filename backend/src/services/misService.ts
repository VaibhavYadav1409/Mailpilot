/**
 * MIS auto-check — connection, sources, the check job, and status lookups.
 *
 * Flow: an admin connects a Microsoft 365 account once (misMicrosoft.ts) and
 * pastes each MSI staff member's MIS spreadsheet link. Every few minutes (and
 * whenever someone opens MSI Reports / the staff MSI page) MailPilot reads the
 * workbook through Microsoft Graph and records, per source and business day:
 * COMPLETE / INCOMPLETE (+ which columns are blank) / MISSING / ERROR.
 * A staff member with MIS sources counts as "submitted" for a day only when
 * ALL of their sources are COMPLETE for that day.
 */
import { prisma } from "../lib/db";
import { Prisma } from "../generated/prisma/client";
import { emitToCompany } from "../sockets";
import { encryptToken } from "../lib/crypto";
import { checkMisWorkbook, normHeader, type MisBlank, type MisCheckResult, type MisField } from "./misSheet";
import {
  MisGraphError,
  cacheMisToken,
  exchangeMisCode,
  forgetMisToken,
  getMisAccessToken,
  readWorkbook,
  resolveShareLink,
} from "./misMicrosoft";
import { availableDates, businessDateString, dateColumnValue } from "./msiService";

export type MisSourceStatus = "COMPLETE" | "INCOMPLETE" | "MISSING" | "ERROR" | "NOT_CHECKED";

export class MisError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const CHECK_RETENTION_DAYS = 7;
/** Background job interval and the "fresh enough" window for on-demand checks. */
export const MIS_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const ON_DEMAND_MAX_AGE_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getMisConnection(companyId: string) {
  const c = await prisma.misConnection.findUnique({ where: { companyId } });
  return c
    ? { connected: true, accountEmail: c.accountEmail, status: c.status, lastError: c.lastError, connectedAt: c.createdAt.toISOString() }
    : { connected: false as const };
}

export async function completeMisConnect(companyId: string, employeeId: string, code: string) {
  const t = await exchangeMisCode(code);
  await prisma.misConnection.upsert({
    where: { companyId },
    create: { companyId, accountEmail: t.email, refreshTokenEnc: encryptToken(t.refreshToken), connectedById: employeeId },
    update: {
      accountEmail: t.email,
      refreshTokenEnc: encryptToken(t.refreshToken),
      connectedById: employeeId,
      status: "CONNECTED",
      lastError: null,
    },
  });
  cacheMisToken(companyId, t.accessToken, t.expiresIn);
  // Re-resolve every link with the new account on the next check.
  await prisma.misSource.updateMany({ where: { companyId }, data: { lastCheckedAt: null } });
  void runMisChecks(companyId, { force: true }).catch((e) => console.error("[MIS] check after connect failed:", e));
  return t.email;
}

export async function disconnectMis(companyId: string) {
  forgetMisToken(companyId);
  await prisma.misConnection.deleteMany({ where: { companyId } });
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const asStringArray = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.map((x) => normHeader(x)).filter(Boolean) : null;

export function validateShareUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MisError(400, "Paste the full link to the Excel file (starting with https://).");
  }
  const host = url.hostname.toLowerCase();
  const ok =
    url.protocol === "https:" &&
    (host.endsWith(".sharepoint.com") || host === "onedrive.live.com" || host === "1drv.ms" || host.endsWith(".sharepoint.us"));
  if (!ok) throw new MisError(400, "Only SharePoint / OneDrive links are supported.");
  return url.toString();
}

export interface MisSourceInput {
  employeeId?: string;
  label?: string;
  shareUrl?: string;
  sheetName?: string | null;
  dateColumn?: string | null;
  requiredColumns?: string[] | null;
}

function cleanOptional(s: string | null | undefined): string | null | undefined {
  if (s === undefined) return undefined;
  const v = (s ?? "").trim();
  return v ? v : null;
}

export async function createMisSource(companyId: string, input: MisSourceInput) {
  if (!input.employeeId) throw new MisError(400, "Choose the staff member.");
  const employee = await prisma.employee.findFirst({ where: { id: input.employeeId, companyId }, select: { id: true } });
  if (!employee) throw new MisError(404, "Staff member not found.");
  const source = await prisma.misSource.create({
    data: {
      companyId,
      employeeId: employee.id,
      label: (input.label ?? "").trim().slice(0, 80) || "MIS",
      shareUrl: validateShareUrl(input.shareUrl ?? ""),
      sheetName: cleanOptional(input.sheetName) ?? null,
      dateColumn: cleanOptional(input.dateColumn) ?? null,
      requiredColumns: input.requiredColumns?.length ? input.requiredColumns.map(normHeader).filter(Boolean) : undefined,
    },
  });
  void runMisChecks(companyId, { sourceId: source.id, force: true }).catch((e) => console.error("[MIS] first check failed:", e));
  return source.id;
}

export async function updateMisSource(companyId: string, id: string, input: MisSourceInput) {
  const existing = await prisma.misSource.findFirst({ where: { id, companyId } });
  if (!existing) throw new MisError(404, "MIS file not found.");
  const shareUrl = input.shareUrl !== undefined ? validateShareUrl(input.shareUrl) : undefined;
  await prisma.misSource.update({
    where: { id },
    data: {
      label: input.label !== undefined ? input.label.trim().slice(0, 80) || "MIS" : undefined,
      shareUrl,
      // A new link must be resolved again.
      ...(shareUrl && shareUrl !== existing.shareUrl ? { driveId: null, itemId: null, fileName: null, webUrl: null } : {}),
      sheetName: cleanOptional(input.sheetName),
      dateColumn: cleanOptional(input.dateColumn),
      requiredColumns:
        input.requiredColumns === undefined
          ? undefined
          : input.requiredColumns === null || input.requiredColumns.length === 0
          ? Prisma.DbNull // back to "every column"
          : input.requiredColumns.map(normHeader).filter(Boolean),
      lastCheckedAt: null,
    },
  });
  await runMisChecks(companyId, { sourceId: id, force: true }).catch((e) => console.error("[MIS] re-check failed:", e));
}

export async function deleteMisSource(companyId: string, id: string) {
  const { count } = await prisma.misSource.deleteMany({ where: { id, companyId } });
  if (!count) throw new MisError(404, "MIS file not found.");
  emitToCompany(companyId, "msi:updated", { reportDate: businessDateString() });
}

function publicCheck(c: {
  status: string;
  rowCount: number;
  missingColumns: unknown;
  incompleteRows: unknown;
  note: string | null;
  completedAt: Date | null;
  checkedAt: Date;
} | null | undefined) {
  if (!c) return null;
  return {
    status: c.status as MisSourceStatus,
    rowCount: c.rowCount,
    missingColumns: asStringArray(c.missingColumns) ?? [],
    blanks: (Array.isArray(c.incompleteRows) ? c.incompleteRows : []) as unknown as MisBlank[],
    note: c.note,
    completedAt: c.completedAt?.toISOString() ?? null,
    checkedAt: c.checkedAt.toISOString(),
  };
}

/** Admin list: every source with today's result. */
export async function listMisSources(companyId: string, now = new Date()) {
  const today = businessDateString(now);
  const sources = await prisma.misSource.findMany({
    where: { companyId },
    orderBy: [{ employeeId: "asc" }, { createdAt: "asc" }],
    include: { checks: { where: { checkDate: dateColumnValue(today) }, take: 1 } },
  });
  return sources.map((s) => ({
    id: s.id,
    employeeId: s.employeeId,
    label: s.label,
    shareUrl: s.shareUrl,
    fileName: s.fileName,
    webUrl: s.webUrl ?? s.shareUrl,
    sheetName: s.sheetName,
    dateColumn: s.dateColumn,
    requiredColumns: asStringArray(s.requiredColumns),
    fields: (Array.isArray(s.detectedColumns) ? s.detectedColumns : []) as unknown as MisField[],
    lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
    lastError: s.lastError,
    today: publicCheck(s.checks[0]),
  }));
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<void>>();

/**
 * Checks MIS sources of one company for today and yesterday. Concurrent calls
 * for the same company share one run.
 */
export function runMisChecks(
  companyId: string,
  opts: { sourceId?: string; employeeId?: string; force?: boolean } = {},
): Promise<void> {
  const k = `${companyId}:${opts.sourceId ?? opts.employeeId ?? "*"}`;
  const inflight = running.get(k);
  if (inflight) return inflight;
  const p = doRun(companyId, opts).finally(() => running.delete(k));
  running.set(k, p);
  return p;
}

async function doRun(companyId: string, opts: { sourceId?: string; employeeId?: string; force?: boolean }) {
  const now = new Date();
  const dates = availableDates(now); // [today, yesterday]
  const sources = await prisma.misSource.findMany({
    where: {
      companyId,
      ...(opts.sourceId ? { id: opts.sourceId } : {}),
      ...(opts.employeeId ? { employeeId: opts.employeeId } : {}),
      ...(opts.force ? {} : { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - 60_000) } }] }),
    },
  });
  if (sources.length === 0) return;

  let token: string;
  try {
    token = await getMisAccessToken(companyId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.misSource.updateMany({ where: { id: { in: sources.map((s) => s.id) } }, data: { lastError: msg.slice(0, 1000), lastCheckedAt: now } });
    return;
  }

  let changed = false;
  for (const s of sources) {
    try {
      let { driveId, itemId } = s;
      const patch: Record<string, unknown> = {};
      if (!driveId || !itemId) {
        const r = await resolveShareLink(token, s.shareUrl);
        ({ driveId, itemId } = r);
        Object.assign(patch, r);
      }
      const sheets = await readWorkbook(token, driveId!, itemId!, dates, s.sheetName);
      const results = dates.map((date) => ({
        date,
        result: checkMisWorkbook(sheets, {
          date,
          sheetName: s.sheetName,
          dateColumn: s.dateColumn,
          requiredColumns: asStringArray(s.requiredColumns),
        }),
      }));
      const detected: MisField[] = results[0].result.fields;
      await prisma.misSource.update({
        where: { id: s.id },
        data: { ...patch, detectedColumns: detected as unknown as Prisma.InputJsonValue, lastCheckedAt: now, lastError: null },
      });
      for (const { date, result } of results) {
        changed = (await saveCheck(s, date, result, now)) || changed;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[MIS] check failed for source ${s.id}:`, msg);
      await prisma.misSource.update({ where: { id: s.id }, data: { lastError: msg.slice(0, 1000), lastCheckedAt: now } });
      // Keep a COMPLETE result if Graph hiccups later in the day; otherwise record the error.
      const existing = await prisma.misDailyCheck.findUnique({
        where: { sourceId_checkDate: { sourceId: s.id, checkDate: dateColumnValue(dates[0]) } },
      });
      if (!existing || existing.status !== "COMPLETE") {
        await prisma.misDailyCheck.upsert({
          where: { sourceId_checkDate: { sourceId: s.id, checkDate: dateColumnValue(dates[0]) } },
          create: {
            sourceId: s.id,
            companyId,
            employeeId: s.employeeId,
            checkDate: dateColumnValue(dates[0]),
            status: "ERROR",
            note: msg.slice(0, 1000),
            checkedAt: now,
          },
          update: { status: "ERROR", note: msg.slice(0, 1000), checkedAt: now },
        });
        changed = changed || existing?.status !== "ERROR";
      }
      if (e instanceof MisGraphError && e.reconnect) break; // every other source would fail the same way
    }
  }
  if (changed) emitToCompany(companyId, "msi:updated", { reportDate: dates[0], source: "mis" });
}

/** Upserts one day's result. Returns true when the status or blanks changed. */
async function saveCheck(
  s: { id: string; companyId: string; employeeId: string },
  date: string,
  r: MisCheckResult,
  now: Date,
): Promise<boolean> {
  const where = { sourceId_checkDate: { sourceId: s.id, checkDate: dateColumnValue(date) } };
  const prev = await prisma.misDailyCheck.findUnique({ where });
  const completedAt = r.status === "COMPLETE" ? prev?.completedAt ?? now : null;
  const data = {
    status: r.status,
    rowCount: r.filledCount,
    missingColumns: r.missingFields,
    incompleteRows: r.blanks as unknown as Prisma.InputJsonValue,
    note: r.note ?? (r.sheet ? `Sheet: ${r.sheet}` : null),
    completedAt,
    checkedAt: now,
  };
  await prisma.misDailyCheck.upsert({
    where,
    create: { sourceId: s.id, companyId: s.companyId, employeeId: s.employeeId, checkDate: dateColumnValue(date), ...data },
    update: data,
  });
  return (
    !prev ||
    prev.status !== r.status ||
    JSON.stringify(asStringArray(prev.missingColumns) ?? []) !== JSON.stringify(r.missingFields)
  );
}

/** Runs a check if the data is older than a few minutes; waits at most `timeoutMs`. */
export async function ensureMisFresh(companyId: string, opts: { employeeId?: string; timeoutMs?: number } = {}) {
  const stale = await prisma.misSource.count({
    where: {
      companyId,
      ...(opts.employeeId ? { employeeId: opts.employeeId } : {}),
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - ON_DEMAND_MAX_AGE_MS) } }],
    },
  });
  if (!stale) return;
  const run = runMisChecks(companyId, { employeeId: opts.employeeId }).catch((e) => console.error("[MIS] on-demand check failed:", e));
  await Promise.race([run, new Promise((r) => setTimeout(r, opts.timeoutMs ?? 8000))]);
}

/** Scheduler entry point: every company with a connection. */
export async function runAllMisChecks() {
  const conns = await prisma.misConnection.findMany({ where: { status: "CONNECTED" }, select: { companyId: true } });
  for (const c of conns) await runMisChecks(c.companyId).catch((e) => console.error("[MIS] scheduled check failed:", e));
}

export async function purgeOldMisChecks(now = new Date()) {
  const cutoff = dateColumnValue(availableDates(now).at(-1)!);
  const oldest = new Date(cutoff.getTime() - (CHECK_RETENTION_DAYS - 2) * 86400000);
  const { count } = await prisma.misDailyCheck.deleteMany({ where: { checkDate: { lt: oldest } } });
  return count;
}

// ---------------------------------------------------------------------------
// Status for MSI Reports / the staff MSI page
// ---------------------------------------------------------------------------

export interface MisEmployeeDay {
  status: MisSourceStatus; // aggregated over the person's sources
  submitted: boolean; // every source COMPLETE
  completedAt: string | null; // when the last source became complete
  missingColumns: string[];
  sources: {
    id: string;
    label: string;
    fileName: string | null;
    webUrl: string;
    status: MisSourceStatus;
    rowCount: number;
    missingColumns: string[];
    blanks: MisBlank[];
    note: string | null;
    checkedAt: string | null;
  }[];
}

function aggregate(statuses: MisSourceStatus[]): MisSourceStatus {
  if (statuses.every((s) => s === "COMPLETE")) return "COMPLETE";
  if (statuses.includes("INCOMPLETE")) return "INCOMPLETE";
  if (statuses.includes("MISSING")) return "MISSING";
  if (statuses.includes("ERROR")) return "ERROR";
  return "NOT_CHECKED";
}

/** Map employeeId -> that day's MIS status, only for employees that have MIS sources. */
export async function getMisStatusForDate(companyId: string, date: string, employeeId?: string) {
  const sources = await prisma.misSource.findMany({
    where: { companyId, ...(employeeId ? { employeeId } : {}) },
    orderBy: { createdAt: "asc" },
    include: { checks: { where: { checkDate: dateColumnValue(date) }, take: 1 } },
  });

  const grouped = new Map<string, { row: MisEmployeeDay["sources"][number]; completedAt: string | null }[]>();
  for (const s of sources) {
    const c = publicCheck(s.checks[0]);
    const list = grouped.get(s.employeeId) ?? [];
    list.push({
      row: {
        id: s.id,
        label: s.label,
        fileName: s.fileName,
        webUrl: s.webUrl ?? s.shareUrl,
        status: c?.status ?? "NOT_CHECKED",
        rowCount: c?.rowCount ?? 0,
        missingColumns: c?.missingColumns ?? [],
        blanks: c?.blanks ?? [],
        note: c?.note ?? s.lastError ?? null,
        checkedAt: c?.checkedAt ?? s.lastCheckedAt?.toISOString() ?? null,
      },
      completedAt: c?.completedAt ?? null,
    });
    grouped.set(s.employeeId, list);
  }

  const byEmployee = new Map<string, MisEmployeeDay>();
  for (const [empId, list] of grouped) {
    const status = aggregate(list.map((x) => x.row.status));
    const done = list.map((x) => x.completedAt).filter((d): d is string => Boolean(d)).sort();
    byEmployee.set(empId, {
      status,
      submitted: status === "COMPLETE",
      completedAt: status === "COMPLETE" ? done.at(-1) ?? null : null,
      missingColumns: [...new Set(list.flatMap((x) => x.row.missingColumns))],
      sources: list.map((x) => x.row),
    });
  }
  return byEmployee;
}
