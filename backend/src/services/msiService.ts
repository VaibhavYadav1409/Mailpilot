import path from "node:path";
import { prisma } from "../lib/db";
import { deleteMsiFiles, getMsiFile, makeMsiStorageKey, putMsiFile, sweepOrphanMsiFiles } from "../lib/msiStorage";
import { getMailDayTimezone } from "./retentionEngine";
import { emitToCompany } from "../sockets";

/**
 * MSI Daily Work Report — business logic.
 *
 * ---------------------------------------------------------------------------
 * RETENTION POLICY (hard requirement: MSI data is temporary)
 * ---------------------------------------------------------------------------
 * - A report belongs to a "business day": the calendar date in
 *   MAIL_DAY_TIMEZONE (default Asia/Kolkata, the same day boundary the daily
 *   mail wipe uses), computed from the SERVER clock. The browser's date and
 *   timezone are never trusted.
 * - expiresAt = 00:00 of (reportDate + RETENTION_DAYS) in that timezone.
 *     reportDate 24 Sep  ->  expiresAt 26 Sep 00:00 IST
 *     24 Sep: active | 25 Sep: active | from 26 Sep 00:00: expired
 * - Expired rows are hidden from every read immediately (all queries filter
 *   expiresAt > now), and physically deleted — row + file + message, all of
 *   it — by purgeExpiredMsiReports(), which the scheduler runs hourly and on
 *   boot. The purge only ever touches MsiDailyReport / MsiReportFile.
 * ---------------------------------------------------------------------------
 */

export const RETENTION_DAYS = 2;

/** Roles expected to submit a daily report. CEO/COO/ADMIN are the readers; they can still submit and will show as submitted if they do. */
export const MSI_REPORTING_ROLES = ["EMPLOYEE", "MANAGER"] as const;

const DEFAULT_MAX_FILE_MB = 5;
const MAX_MESSAGE_CHARS = 2000;
const MAX_FILENAME_CHARS = 150;

export function getMsiMaxFileBytes(): number {
  const n = Number(process.env.MSI_MAX_FILE_MB);
  const mb = Number.isFinite(n) && n > 0 ? Math.min(n, 15) : DEFAULT_MAX_FILE_MB; // 15 MB ceiling: uploads are base64 JSON on a 256 MB heap
  return Math.floor(mb * 1024 * 1024);
}

export function getMsiTimezone(): string {
  return getMailDayTimezone();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD" for `now` in the business timezone. */
export function businessDateString(now: Date = new Date(), tz: string = getMsiTimezone()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Adds whole calendar days to a "YYYY-MM-DD" string. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Value for a Postgres DATE column (Prisma maps @db.Date via a UTC-midnight Date). */
export function dateColumnValue(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUTC - date.getTime();
}

/** The real instant at which local midnight of `dateStr` happens in `tz`. DST-safe. */
export function startOfBusinessDay(dateStr: string, tz: string = getMsiTimezone()): Date {
  const wallMidnight = dateColumnValue(dateStr).getTime();
  let instant = wallMidnight - tzOffsetMs(new Date(wallMidnight), tz);
  // Re-check once in case the offset differs at the corrected instant (DST edge).
  instant = wallMidnight - tzOffsetMs(new Date(instant), tz);
  return new Date(instant);
}

/** See RETENTION POLICY above. */
export function expiresAtFor(reportDate: string, tz: string = getMsiTimezone()): Date {
  return startOfBusinessDay(addDays(reportDate, RETENTION_DAYS), tz);
}

/** Business dates whose reports can still exist right now: today, yesterday (newest first). */
export function availableDates(now: Date = new Date(), tz: string = getMsiTimezone()): string[] {
  const today = businessDateString(now, tz);
  return Array.from({ length: RETENTION_DAYS }, (_, i) => addDays(today, -i));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class MsiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Signature = "pdf" | "zip" | "ole" | "png" | "jpg" | "text" | "rtf";

// Extension -> [MIME type served on download, expected content signature].
// The MIME type the client claims is ignored; the server decides from the
// extension and then checks the bytes actually look like that kind of file.
const FILE_TYPES: Record<string, [string, Signature]> = {
  pdf: ["application/pdf", "pdf"],
  doc: ["application/msword", "ole"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "zip"],
  xls: ["application/vnd.ms-excel", "ole"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "zip"],
  ppt: ["application/vnd.ms-powerpoint", "ole"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "zip"],
  odt: ["application/vnd.oasis.opendocument.text", "zip"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet", "zip"],
  odp: ["application/vnd.oasis.opendocument.presentation", "zip"],
  csv: ["text/csv", "text"],
  txt: ["text/plain", "text"],
  rtf: ["application/rtf", "rtf"],
  png: ["image/png", "png"],
  jpg: ["image/jpeg", "jpg"],
  jpeg: ["image/jpeg", "jpg"],
};

export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

function startsWith(buf: Buffer, bytes: number[]): boolean {
  return buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
}

function matchesSignature(buf: Buffer, sig: Signature): boolean {
  switch (sig) {
    case "pdf":
      return startsWith(buf, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case "zip":
      return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]); // PK.. (OOXML / ODF)
    case "ole":
      return startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy Office
    case "png":
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47]);
    case "jpg":
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case "rtf":
      return buf.subarray(0, 5).toString("latin1") === "{\\rtf";
    case "text":
      // Plain text/CSV: reject anything with NUL bytes (i.e. a binary renamed to .txt).
      return !buf.subarray(0, 8192).includes(0);
  }
}

/** Strips any path, control and reserved characters; keeps a readable name. Never used as a storage path. */
export function sanitizeFileName(raw: string): string {
  const base = path.basename(String(raw).replace(/\\/g, "/"));
  let name = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (name.length > MAX_FILENAME_CHARS) {
    const ext = path.extname(name).slice(0, 10);
    name = name.slice(0, MAX_FILENAME_CHARS - ext.length) + ext;
  }
  return name || "report";
}

export interface IncomingFile {
  fileName: string;
  dataBase64: string;
}

export interface ValidatedFile {
  fileName: string;
  fileType: string;
  data: Buffer;
}

export function validateFile(file: IncomingFile | undefined | null): ValidatedFile {
  if (!file || !file.fileName || !file.dataBase64) {
    throw new MsiError(400, "NO_FILE", "Please select your daily report.");
  }
  const fileName = sanitizeFileName(file.fileName);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const type = FILE_TYPES[ext];
  if (!type) throw new MsiError(415, "UNSUPPORTED_TYPE", "This file type is not supported.");

  const maxBytes = getMsiMaxFileBytes();
  // Cheap pre-check on the encoded length so an oversized upload is rejected before decoding.
  if (file.dataBase64.length > Math.ceil((maxBytes * 4) / 3) + 8) {
    throw new MsiError(413, "FILE_TOO_LARGE", "File exceeds the allowed size.");
  }
  const cleaned = file.dataBase64.replace(/^data:[^,]*,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new MsiError(400, "BAD_ENCODING", "Upload failed. Please try again.");
  }
  const data = Buffer.from(cleaned, "base64");
  if (data.length === 0) throw new MsiError(400, "EMPTY_FILE", "The selected file is empty.");
  if (data.length > maxBytes) throw new MsiError(413, "FILE_TOO_LARGE", "File exceeds the allowed size.");
  if (!matchesSignature(data, type[1])) {
    throw new MsiError(415, "CONTENT_MISMATCH", "This file type is not supported.");
  }
  return { fileName, fileType: type[0], data };
}

export function normalizeMessage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const msg = String(raw).replace(/\r\n/g, "\n").trim();
  if (!msg) return null;
  if (msg.length > MAX_MESSAGE_CHARS) {
    throw new MsiError(400, "MESSAGE_TOO_LONG", `Important message can't exceed ${MAX_MESSAGE_CHARS} characters.`);
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Shapes returned to clients (never includes storageReference)
// ---------------------------------------------------------------------------

const reportPublicSelect = {
  id: true,
  employeeId: true,
  reportDate: true,
  fileName: true,
  fileType: true,
  fileSize: true,
  importantMessage: true,
  status: true,
  submittedAt: true,
  updatedAt: true,
  expiresAt: true,
} as const;

type ReportRow = {
  id: string;
  employeeId: string;
  reportDate: Date;
  fileName: string;
  fileType: string;
  fileSize: number;
  importantMessage: string | null;
  status: string;
  submittedAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export function toPublicReport(r: ReportRow) {
  return {
    id: r.id,
    reportDate: r.reportDate.toISOString().slice(0, 10),
    fileName: r.fileName,
    fileType: r.fileType,
    fileSize: r.fileSize,
    importantMessage: r.importantMessage,
    hasImportantMessage: Boolean(r.importantMessage),
    status: r.status,
    submittedAt: r.submittedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  };
}
export type PublicMsiReport = ReturnType<typeof toPublicReport>;

export interface MsiActor {
  employeeId: string;
  companyId: string;
}

function audit(companyId: string, employeeId: string | null, action: string, metadata: Record<string, unknown>) {
  // Existing MailPilot pattern: AuditLog row + console line. Metadata never
  // contains file contents, filenames or message text. Fire-and-forget so an
  // audit failure can never fail the user's request.
  console.log(`[MSI] ${action}`, JSON.stringify(metadata));
  prisma.auditLog
    .create({ data: { companyId, employeeId, action, metadata: metadata as object } })
    .catch((e: unknown) => console.error("[MSI] audit log write failed:", e instanceof Error ? e.message : e));
}

function notifyDashboards(companyId: string, reportDate: string) {
  emitToCompany(companyId, "msi:updated", { reportDate });
}

// ---------------------------------------------------------------------------
// Employee operations
// ---------------------------------------------------------------------------

export async function getTodayForEmployee(actor: MsiActor, now = new Date()) {
  const reportDate = businessDateString(now);
  const report = await prisma.msiDailyReport.findFirst({
    where: { employeeId: actor.employeeId, reportDate: dateColumnValue(reportDate), expiresAt: { gt: now } },
    select: reportPublicSelect,
  });
  return {
    reportDate,
    timezone: getMsiTimezone(),
    serverTime: now.toISOString(),
    submitted: Boolean(report),
    report: report ? toPublicReport(report) : null,
    rules: {
      maxFileBytes: getMsiMaxFileBytes(),
      allowedExtensions: ALLOWED_EXTENSIONS,
      retentionDays: RETENTION_DAYS,
      maxMessageChars: MAX_MESSAGE_CHARS,
    },
  };
}

/** Today + yesterday for the employee — the only days that can still exist. */
export async function getRecentForEmployee(actor: MsiActor, now = new Date()) {
  const dates = availableDates(now);
  const rows = await prisma.msiDailyReport.findMany({
    where: { employeeId: actor.employeeId, reportDate: { in: dates.map(dateColumnValue) }, expiresAt: { gt: now } },
    select: reportPublicSelect,
  });
  const byDate = new Map(rows.map((r) => [r.reportDate.toISOString().slice(0, 10), toPublicReport(r)]));
  return {
    retentionDays: RETENTION_DAYS,
    days: dates.map((date, i) => ({
      date,
      label: i === 0 ? "Today" : "Yesterday",
      submitted: byDate.has(date),
      report: byDate.get(date) ?? null,
    })),
  };
}

export async function createTodayReport(
  actor: MsiActor,
  input: { file?: IncomingFile | null; importantMessage?: unknown },
  now = new Date(),
) {
  const reportDate = businessDateString(now);
  const dateValue = dateColumnValue(reportDate);

  const existing = await prisma.msiDailyReport.findFirst({
    where: { employeeId: actor.employeeId, reportDate: dateValue },
    select: { ...reportPublicSelect, storageReference: true },
  });
  if (existing && existing.expiresAt > now) {
    const err = new MsiError(409, "ALREADY_SUBMITTED", "You've already submitted today's report. Use Update Report to change it.");
    (err as MsiError & { report?: PublicMsiReport }).report = toPublicReport(existing);
    throw err;
  }

  const file = validateFile(input.file);
  const importantMessage = normalizeMessage(input.importantMessage);
  const storageReference = makeMsiStorageKey(actor.companyId);

  await putMsiFile(storageReference, file.data);
  try {
    const created = await prisma.msiDailyReport.create({
      data: {
        companyId: actor.companyId,
        employeeId: actor.employeeId,
        reportDate: dateValue,
        fileName: file.fileName,
        fileType: file.fileType,
        fileSize: file.data.length,
        storageReference,
        importantMessage,
        status: "SUBMITTED",
        submittedAt: now,
        expiresAt: expiresAtFor(reportDate),
      },
      select: reportPublicSelect,
    });
    audit(actor.companyId, actor.employeeId, "MSI_REPORT_UPLOADED", {
      reportId: created.id,
      reportDate,
      fileSize: created.fileSize,
      hasImportantMessage: Boolean(importantMessage),
    });
    notifyDashboards(actor.companyId, reportDate);
    return toPublicReport(created);
  } catch (e: any) {
    // Don't leave the bytes behind if the row couldn't be written.
    await deleteMsiFiles([storageReference]).catch(() => undefined);
    if (e?.code === "P2002") {
      // Double-click / two tabs racing: the other request won.
      throw new MsiError(409, "ALREADY_SUBMITTED", "You've already submitted today's report. Use Update Report to change it.");
    }
    throw e;
  }
}

/** Loads a report the actor owns, for TODAY only (past days are read-only). */
async function loadOwnTodayReport(actor: MsiActor, reportId: string, now: Date) {
  const report = await prisma.msiDailyReport.findUnique({
    where: { id: reportId },
    select: { ...reportPublicSelect, companyId: true, storageReference: true },
  });
  if (!report || report.employeeId !== actor.employeeId || report.companyId !== actor.companyId || report.expiresAt <= now) {
    throw new MsiError(404, "NOT_FOUND", "Report not found.");
  }
  const today = businessDateString(now);
  if (report.reportDate.toISOString().slice(0, 10) !== today) {
    throw new MsiError(409, "NOT_TODAY", "Only today's report can be changed.");
  }
  return { report, today };
}

export async function updateOwnReport(
  actor: MsiActor,
  reportId: string,
  input: { file?: IncomingFile | null; importantMessage?: unknown },
  now = new Date(),
) {
  const { report, today } = await loadOwnTodayReport(actor, reportId, now);
  const hasFile = Boolean(input.file);
  const hasMessage = input.importantMessage !== undefined;
  if (!hasFile && !hasMessage) throw new MsiError(400, "NOTHING_TO_UPDATE", "Nothing to update.");

  const data: Record<string, unknown> = {};
  if (hasMessage) data.importantMessage = normalizeMessage(input.importantMessage);

  let newKey: string | null = null;
  if (hasFile) {
    const file = validateFile(input.file);
    newKey = makeMsiStorageKey(actor.companyId);
    await putMsiFile(newKey, file.data);
    Object.assign(data, { fileName: file.fileName, fileType: file.fileType, fileSize: file.data.length, storageReference: newKey });
  }

  try {
    const updated = await prisma.msiDailyReport.update({ where: { id: report.id }, data, select: reportPublicSelect });
    // Replace, don't accumulate: the old bytes go as soon as the row points at the new ones.
    if (newKey) await deleteMsiFiles([report.storageReference]).catch(() => undefined);
    audit(actor.companyId, actor.employeeId, "MSI_REPORT_UPDATED", {
      reportId: report.id,
      reportDate: today,
      fileReplaced: hasFile,
      messageChanged: hasMessage,
    });
    notifyDashboards(actor.companyId, today);
    return toPublicReport(updated);
  } catch (e) {
    if (newKey) await deleteMsiFiles([newKey]).catch(() => undefined);
    throw e;
  }
}

export async function deleteOwnReport(actor: MsiActor, reportId: string, now = new Date()) {
  const { report, today } = await loadOwnTodayReport(actor, reportId, now);
  await prisma.msiDailyReport.delete({ where: { id: report.id } });
  await deleteMsiFiles([report.storageReference]).catch(() => undefined);
  audit(actor.companyId, actor.employeeId, "MSI_REPORT_WITHDRAWN", { reportId: report.id, reportDate: today });
  notifyDashboards(actor.companyId, today);
}

// ---------------------------------------------------------------------------
// Downloads (employee: own only; admin: same company)
// ---------------------------------------------------------------------------

export async function loadReportFileForDownload(
  actor: MsiActor,
  reportId: string,
  mode: "own" | "admin",
  now = new Date(),
) {
  const report = await prisma.msiDailyReport.findUnique({
    where: { id: reportId },
    select: { id: true, companyId: true, employeeId: true, reportDate: true, fileName: true, fileType: true, storageReference: true, expiresAt: true },
  });
  const allowed =
    report &&
    report.companyId === actor.companyId &&
    report.expiresAt > now &&
    (mode === "admin" || report.employeeId === actor.employeeId);
  if (!allowed) throw new MsiError(404, "NOT_FOUND", "Report not found or no longer available.");

  const data = await getMsiFile(report.storageReference);
  if (!data) throw new MsiError(404, "FILE_MISSING", "This report file is no longer available.");

  audit(actor.companyId, actor.employeeId, "MSI_REPORT_DOWNLOADED", {
    reportId: report.id,
    reportDate: report.reportDate.toISOString().slice(0, 10),
    ownerEmployeeId: report.employeeId,
    by: mode,
  });
  return { fileName: report.fileName, fileType: report.fileType, data };
}

// ---------------------------------------------------------------------------
// CEO / admin overview
// ---------------------------------------------------------------------------

export type MsiAdminFilter = "all" | "submitted" | "not_submitted" | "important";

export interface MsiEmployeeStatus {
  employeeId: string;
  name: string;
  email: string;
  department: string | null;
  role: string;
  submitted: boolean;
  report: PublicMsiReport | null;
}

/**
 * Everything the CEO dashboard needs for one business date, in exactly two
 * indexed queries (employees of the company + that date's reports), merged in
 * memory — never one query per employee.
 */
export async function getAdminOverview(companyId: string, dateParam: string | undefined, now = new Date()) {
  const today = businessDateString(now);
  const dates = availableDates(now);
  const date = dateParam ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new MsiError(400, "BAD_DATE", "Invalid date.");
  }
  if (date > today) throw new MsiError(400, "FUTURE_DATE", "That date hasn't happened yet.");

  const base = { date, today, timezone: getMsiTimezone(), availableDates: dates, retentionDays: RETENTION_DAYS };

  // Older than the retention window: everything for that day has been deleted
  // by policy, so there is nothing to look up (and "not submitted" would be a lie).
  if (!dates.includes(date)) {
    return {
      ...base,
      expired: true,
      summary: { totalEmployees: 0, submitted: 0, notSubmitted: 0, important: 0, submissionRate: 0 },
      submitted: [] as MsiEmployeeStatus[],
      notSubmitted: [] as MsiEmployeeStatus[],
    };
  }

  const [employees, reports] = await Promise.all([
    prisma.employee.findMany({
      where: { companyId, status: { not: "SUSPENDED" } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        department: { select: { name: true } },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.msiDailyReport.findMany({
      where: { companyId, reportDate: dateColumnValue(date), expiresAt: { gt: now } },
      select: reportPublicSelect,
    }),
  ]);

  const reportByEmployee = new Map(reports.map((r) => [r.employeeId, toPublicReport(r)]));
  const reportingRoles = new Set<string>(MSI_REPORTING_ROLES);

  const submitted: MsiEmployeeStatus[] = [];
  const notSubmitted: MsiEmployeeStatus[] = [];
  for (const e of employees) {
    const report = reportByEmployee.get(e.id) ?? null;
    // Leadership roles only appear if they actually submitted something.
    if (!report && !reportingRoles.has(e.role)) continue;
    const row: MsiEmployeeStatus = {
      employeeId: e.id,
      name: `${e.firstName} ${e.lastName}`.trim(),
      email: e.email,
      department: e.department?.name ?? null,
      role: e.role,
      submitted: Boolean(report),
      report,
    };
    (report ? submitted : notSubmitted).push(row);
  }
  submitted.sort((a, b) => (a.report!.submittedAt < b.report!.submittedAt ? -1 : 1));

  const total = submitted.length + notSubmitted.length;
  const important = submitted.filter((s) => s.report?.hasImportantMessage).length;
  return {
    ...base,
    expired: false,
    summary: {
      totalEmployees: total,
      submitted: submitted.length,
      notSubmitted: notSubmitted.length,
      important,
      submissionRate: total ? Math.round((submitted.length / total) * 100) : 0,
    },
    submitted,
    notSubmitted,
  };
}

export function applyAdminFilter<T extends { submitted: MsiEmployeeStatus[]; notSubmitted: MsiEmployeeStatus[] }>(
  overview: T,
  filter: MsiAdminFilter,
): T {
  switch (filter) {
    case "submitted":
      return { ...overview, notSubmitted: [] };
    case "not_submitted":
      return { ...overview, submitted: [] };
    case "important":
      return { ...overview, submitted: overview.submitted.filter((s) => s.report?.hasImportantMessage), notSubmitted: [] };
    default:
      return overview;
  }
}

// ---------------------------------------------------------------------------
// Retention job (called from scheduler.ts)
// ---------------------------------------------------------------------------

export interface MsiPurgeResult {
  reportsDeleted: number;
  filesDeleted: number;
  orphanFilesDeleted: number;
  cutoff: string;
}

let purgeRunning = false;

/**
 * Deletes every MSI report whose expiresAt has passed: the DB row (which holds
 * the metadata and the important message) and its stored file. Touches ONLY
 * MsiDailyReport and MSI storage — never emails, employees, analytics, auth or
 * any other MailPilot data.
 */
export async function purgeExpiredMsiReports(now = new Date()): Promise<MsiPurgeResult> {
  const result: MsiPurgeResult = { reportsDeleted: 0, filesDeleted: 0, orphanFilesDeleted: 0, cutoff: now.toISOString() };
  if (purgeRunning) return result;
  purgeRunning = true;
  try {
    const touchedCompanies = new Set<string>();
    // Batches keep memory flat even after a long outage.
    for (;;) {
      const expired = await prisma.msiDailyReport.findMany({
        where: { expiresAt: { lte: now } },
        select: { id: true, storageReference: true, companyId: true },
        take: 200,
      });
      if (expired.length === 0) break;
      // Row first: from this point nothing references the file, so no UI can
      // offer a broken download. If the file delete then fails, the orphan
      // sweep below (or the next run) removes it.
      const { count } = await prisma.msiDailyReport.deleteMany({ where: { id: { in: expired.map((r) => r.id) } } });
      result.reportsDeleted += count;
      result.filesDeleted += await deleteMsiFiles(expired.map((r) => r.storageReference)).catch((e) => {
        console.error("[MSI] file delete during purge failed:", e instanceof Error ? e.message : e);
        return 0;
      });
      expired.forEach((r) => touchedCompanies.add(r.companyId));
      if (expired.length < 200) break;
    }

    // Backstop: files with no report row (crash mid-upload, failed delete above).
    const live = await prisma.msiDailyReport.findMany({ select: { storageReference: true } });
    result.orphanFilesDeleted = await sweepOrphanMsiFiles(
      new Set(live.map((r) => r.storageReference)),
      new Date(now.getTime() - 60 * 60 * 1000),
    );

    for (const companyId of touchedCompanies) {
      emitToCompany(companyId, "msi:updated", { purged: true });
    }
    return result;
  } finally {
    purgeRunning = false;
  }
}
