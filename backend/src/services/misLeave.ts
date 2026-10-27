/**
 * Leave records.
 *
 * Staff ask for leave through the company's Google leave form. A small Apps
 * Script in the form's response sheet sends every response to MailPilot
 * (POST /api/mis/leaves/form/<token>): on each new submission, and once an
 * hour for the whole sheet (so edits made in the sheet are picked up too).
 *
 * Rules (from Farsight HR, 12 Oct 2026):
 *   - asked at least `noticeDays` (default 2) days before the leave starts
 *     → PLANNED leave, approved automatically;
 *   - asked later than that, or after the leave was taken → EMERGENCY leave,
 *     also approved automatically, but shown as emergency.
 * Approved leave days need no MIS: they are never red circles, no warning or
 * result email goes out for them, and the Circle Report shows OL (planned) or
 * EL (emergency) — for past days too, so everything updates retroactively.
 *
 * HR / CEO / COO can add, edit, reject or delete any record in MailPilot.
 * A record edited there is never overwritten by the form again.
 */
import crypto from "node:crypto";
import { prisma } from "../lib/db";
import { Prisma } from "../generated/prisma/client";
import { parseMisDate } from "./misSheet";
import { addDaysTo, forPerson, getWorkCalendar, isWorkingDay, shortDate, type WorkCalendar } from "./workCalendar";

export class LeaveError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type LeaveType = "PLANNED" | "EMERGENCY" | "ABSENT" | "SATURDAY_OFF";
export const LEAVE_TYPES: LeaveType[] = ["PLANNED", "EMERGENCY", "ABSENT", "SATURDAY_OFF"];
const LEAVE_LABEL: Record<LeaveType, string> = { PLANNED: "Planned leave", EMERGENCY: "Emergency leave", ABSENT: "Absent", SATURDAY_OFF: "Saturday off" };
export type LeaveStatus = "APPROVED" | "REJECTED";
export const LEAVE_CODE: Record<LeaveType, "OL" | "EL" | "A" | "SO"> = { PLANNED: "OL", EMERGENCY: "EL", ABSENT: "A", SATURDAY_OFF: "SO" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dateValue = (d: string) => new Date(`${d}T00:00:00.000Z`);
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** Whole calendar days from a to b ("YYYY-MM-DD"). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** PLANNED when asked at least `noticeDays` before the first day of leave, else EMERGENCY. */
export function classifyLeave(submittedDate: string | null, from: string, noticeDays: number): LeaveType {
  if (!submittedDate) return "PLANNED";
  return daysBetween(submittedDate, from) >= noticeDays ? "PLANNED" : "EMERGENCY";
}

/** Every date from..to (inclusive). */
export function expandDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysTo(d, 1)) out.push(d);
  return out;
}

export function workingDaysIn(from: string, to: string, cal: WorkCalendar): number {
  return expandDates(from, to).filter((d) => isWorkingDay(d, cal)).length;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getLeaveSettings(companyId: string) {
  const existing = await prisma.misLeaveSettings.findUnique({ where: { companyId } });
  if (existing) return existing;
  return prisma.misLeaveSettings.upsert({
    where: { companyId },
    create: { companyId, token: crypto.randomBytes(24).toString("hex") },
    update: {},
  });
}

export async function updateLeaveSettings(companyId: string, input: { noticeDays?: number }) {
  await getLeaveSettings(companyId);
  if (input.noticeDays !== undefined && (!Number.isInteger(input.noticeDays) || input.noticeDays < 0 || input.noticeDays > 30))
    throw new LeaveError(400, "Notice days must be a whole number from 0 to 30.");
  const s = await prisma.misLeaveSettings.update({ where: { companyId }, data: { noticeDays: input.noticeDays } });
  // Re-classify form records nobody edited by hand.
  if (input.noticeDays !== undefined) {
    const rows = await prisma.misLeave.findMany({ where: { companyId, source: "FORM", editedInApp: false } });
    for (const r of rows) {
      const type = classifyLeave(r.submittedAt ? istDate(r.submittedAt) : null, isoOf(r.fromDate), s.noticeDays);
      if (type !== r.type) await prisma.misLeave.update({ where: { id: r.id }, data: { type } });
    }
  }
  return s;
}

export async function rotateLeaveToken(companyId: string) {
  await getLeaveSettings(companyId);
  return prisma.misLeaveSettings.update({ where: { companyId }, data: { token: crypto.randomBytes(24).toString("hex") } });
}

/** India date of an instant. */
export function istDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// ---------------------------------------------------------------------------
// Reading a form response
// ---------------------------------------------------------------------------

export type LeaveField = "timestamp" | "email" | "name" | "from" | "to" | "days" | "kind" | "reason" | "status";

/** Which form column is which, from the column titles. */
export function mapHeaders(headers: string[]): Partial<Record<LeaveField, string>> {
  const out: Partial<Record<LeaveField, string>> = {};
  const set = (f: LeaveField, h: string) => {
    if (!out[f]) out[f] = h;
  };
  for (const h of headers) {
    const t = h.toLowerCase().replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (/time ?stamp/.test(t)) set("timestamp", h);
    else if (/e-?mail/.test(t)) set("email", h);
    else if (/reason|purpose|remark|detail|comment|description/.test(t)) set("reason", h);
    else if (/\b(type|kind|category|nature)\b/.test(t)) set("kind", h);
    else if (/status|approv/.test(t)) set("status", h);
    else if (/(no\.?|number) of days|total days|^days$|duration|how many days/.test(t)) set("days", h);
    else if (/\b(to|till|until|upto|end|last)\b/.test(t)) set("to", h);
    else if (/\b(from|start|first|begin)\b|date of leave|leave date|leave on|^date$/.test(t)) set("from", h);
    else if (/name/.test(t)) set("name", h);
    else if (/date/.test(t)) {
      if (!out.from) set("from", h);
      else set("to", h);
    }
  }
  return out;
}

/** "2026-10-15T00:00:00", "15/10/2026", an Excel/Sheets serial… -> "YYYY-MM-DD". */
export function readDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(T|\s|$)/.exec(s);
  if (iso) return iso[1];
  return parseMisDate(typeof v === "number" ? v : s);
}

/** Form timestamp (India time, as the script sends it) -> instant. */
export function readTimestamp(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // "12/10/2026 14:05:00" (dd/mm/yyyy, as Indian-locale sheets show it)
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (dm) {
    const d = new Date(`${dm[3]}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}T${(dm[4] ?? "0").padStart(2, "0")}:${dm[5] ?? "00"}:${dm[6] ?? "00"}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export interface ParsedLeave {
  personName: string;
  email: string | null;
  from: string;
  to: string;
  submittedAt: Date | null;
  leaveKind: string | null;
  reason: string | null;
  rejected: boolean;
  formKey: string;
}

/** One form row -> a leave, or the reason it couldn't be read. */
export function parseLeaveRow(row: Record<string, unknown>, map: Partial<Record<LeaveField, string>>): ParsedLeave | { error: string } {
  const get = (f: LeaveField) => (map[f] ? row[map[f]!] : undefined);
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
  const personName = str(get("name"));
  const email = str(get("email")).toLowerCase() || null;
  if (!personName && !email) return { error: "No name or email in this response." };
  const from = readDate(get("from"));
  if (!from) return { error: `Couldn't read the leave date for ${personName || email}.` };
  let to = readDate(get("to"));
  if (!to) {
    const days = Number(str(get("days")).replace(/[^\d.]/g, ""));
    to = Number.isFinite(days) && days >= 1 && days <= 60 ? addDaysTo(from, Math.ceil(days) - 1) : from;
  }
  if (to < from) to = from;
  if (daysBetween(from, to) > 60) return { error: `Leave for ${personName || email} is longer than 60 days (${from} to ${to}) — please check the dates.` };
  const submittedAt = readTimestamp(get("timestamp"));
  const statusText = str(get("status")).toLowerCase();
  const who = (email || personName).toLowerCase();
  return {
    personName: personName || email!,
    email,
    from,
    to,
    submittedAt,
    leaveKind: str(get("kind")) || null,
    reason: str(get("reason")).slice(0, 2000) || null,
    rejected: /reject|declin|not approv|denied/.test(statusText),
    formKey: submittedAt ? `${submittedAt.toISOString()}|${who}` : `${who}|${from}|${to}`,
  };
}

// ---------------------------------------------------------------------------
// Receiving from the form
// ---------------------------------------------------------------------------

export async function people(companyId: string) {
  const list = await prisma.employee.findMany({
    where: { companyId, status: { not: "SUSPENDED" } },
    select: { id: true, firstName: true, lastName: true, email: true, contactEmail: true },
  });
  return list.map((p) => ({
    employeeId: p.id,
    name: `${p.firstName} ${p.lastName}`.trim(),
    email: p.email.toLowerCase(),
    addresses: [p.email.includes("@") ? p.email.toLowerCase() : null, ...(p.contactEmail ?? "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase())].filter(
      (x): x is string => !!x && x.includes("@"),
    ),
  }));
}

/** The MailPilot person a form response is about: by email first, then by name. */
async function matcher(companyId: string) {
  const staff = await people(companyId);
  const { matchPersonByName } = await import("./misEmail");
  return (email: string | null, name: string) => {
    if (email) {
      const byMail = staff.filter((p) => p.addresses.includes(email));
      if (byMail.length === 1) return byMail[0].employeeId;
    }
    return name ? matchPersonByName(staff, name)?.employeeId ?? null : null;
  };
}

export interface ReceiveSummary {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  keptManualEdits: number;
  unmatched: string[];
  errors: string[];
  columns: Partial<Record<LeaveField, string>>;
}

/** Rows from the form script. `mode` is "submit" (one new response) or "sync" (the whole sheet). */
export async function receiveFormRows(token: string, rows: Record<string, unknown>[], mode: string): Promise<ReceiveSummary> {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new LeaveError(404, "Unknown link.");
  const settings = await prisma.misLeaveSettings.findUnique({ where: { token } });
  if (!settings) throw new LeaveError(404, "Unknown link.");
  const companyId = settings.companyId;
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const map = mapHeaders(headers);
  const match = await matcher(companyId);
  const summary: ReceiveSummary = { received: rows.length, created: 0, updated: 0, unchanged: 0, keptManualEdits: 0, unmatched: [], errors: [], columns: map };

  for (const row of rows.slice(0, 5000)) {
    const p = parseLeaveRow(row, map);
    if ("error" in p) {
      summary.errors.push(p.error);
      continue;
    }
    const employeeId = match(p.email, p.personName);
    if (!employeeId) summary.unmatched.push(p.personName);
    const type = classifyLeave(p.submittedAt ? istDate(p.submittedAt) : null, p.from, settings.noticeDays);
    const data = {
      personName: p.personName.slice(0, 200),
      email: p.email,
      fromDate: dateValue(p.from),
      toDate: dateValue(p.to),
      type,
      status: p.rejected ? "REJECTED" : "APPROVED",
      leaveKind: p.leaveKind?.slice(0, 100) ?? null,
      reason: p.reason,
      submittedAt: p.submittedAt,
      raw: row as Prisma.InputJsonValue,
    };
    const existing = await prisma.misLeave.findUnique({ where: { companyId_formKey: { companyId, formKey: p.formKey } } });
    if (!existing) {
      await prisma.misLeave.create({ data: { companyId, employeeId, source: "FORM", formKey: p.formKey, ...data } });
      summary.created++;
    } else if (existing.editedInApp) {
      summary.keptManualEdits++;
    } else {
      const same =
        existing.personName === data.personName &&
        existing.email === data.email &&
        isoOf(existing.fromDate) === p.from &&
        isoOf(existing.toDate) === p.to &&
        existing.type === type &&
        existing.status === data.status &&
        existing.reason === data.reason &&
        existing.leaveKind === data.leaveKind &&
        (existing.employeeId ?? null) === (employeeId ?? existing.employeeId ?? null);
      if (same) summary.unchanged++;
      else {
        await prisma.misLeave.update({ where: { id: existing.id }, data: { ...data, employeeId: employeeId ?? existing.employeeId } });
        summary.updated++;
      }
    }
  }
  summary.unmatched = [...new Set(summary.unmatched)];
  await prisma.misLeaveSettings.update({
    where: { companyId },
    data: { lastReceivedAt: new Date(), lastSummary: { ...summary, mode, at: new Date().toISOString() } as unknown as Prisma.InputJsonValue },
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Editing in MailPilot
// ---------------------------------------------------------------------------

export interface LeaveInput {
  employeeId?: string | null;
  personName?: string;
  from?: string;
  to?: string;
  type?: LeaveType;
  status?: LeaveStatus;
  reason?: string | null;
  note?: string | null;
}

function checkDates(from: string, to: string) {
  if (!ISO.test(from) || !ISO.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new LeaveError(400, "Invalid date.");
  if (to < from) throw new LeaveError(400, "The last day can't be before the first day.");
  if (daysBetween(from, to) > 60) throw new LeaveError(400, "A leave can be at most 60 days — split it into two.");
}

async function checkPerson(companyId: string, employeeId: string | null | undefined) {
  if (!employeeId) return null;
  const e = await prisma.employee.findFirst({ where: { id: employeeId, companyId }, select: { id: true, firstName: true, lastName: true } });
  if (!e) throw new LeaveError(404, "Person not found.");
  return e;
}

export async function createLeave(companyId: string, actorId: string, input: LeaveInput) {
  const from = input.from ?? "";
  const to = input.to ?? from;
  checkDates(from, to);
  const e = await checkPerson(companyId, input.employeeId);
  if (!e) throw new LeaveError(400, "Choose the person.");
  return prisma.misLeave.create({
    data: {
      companyId,
      employeeId: e.id,
      personName: `${e.firstName} ${e.lastName}`.trim(),
      fromDate: dateValue(from),
      toDate: dateValue(to),
      type: input.type ?? "PLANNED",
      status: input.status ?? "APPROVED",
      reason: input.reason?.trim().slice(0, 2000) || null,
      note: input.note?.trim().slice(0, 1000) || null,
      source: "MANUAL",
      editedInApp: true,
      submittedAt: new Date(),
      updatedById: actorId,
    },
  });
}

export async function updateLeave(companyId: string, actorId: string, id: string, input: LeaveInput) {
  const existing = await prisma.misLeave.findFirst({ where: { id, companyId } });
  if (!existing) throw new LeaveError(404, "Leave not found.");
  const from = input.from ?? isoOf(existing.fromDate);
  const to = input.to ?? isoOf(existing.toDate);
  checkDates(from, to);
  if (input.type && !LEAVE_TYPES.includes(input.type)) throw new LeaveError(400, "Unknown leave type.");
  if (input.status && !["APPROVED", "REJECTED"].includes(input.status)) throw new LeaveError(400, "Unknown status.");
  if (input.employeeId !== undefined) await checkPerson(companyId, input.employeeId);
  return prisma.misLeave.update({
    where: { id },
    data: {
      employeeId: input.employeeId === undefined ? undefined : input.employeeId,
      fromDate: dateValue(from),
      toDate: dateValue(to),
      type: input.type,
      status: input.status,
      reason: input.reason === undefined ? undefined : input.reason?.trim().slice(0, 2000) || null,
      note: input.note === undefined ? undefined : input.note?.trim().slice(0, 1000) || null,
      editedInApp: true,
      updatedById: actorId,
    },
  });
}

export async function deleteLeave(companyId: string, id: string) {
  const { count } = await prisma.misLeave.deleteMany({ where: { id, companyId } });
  if (!count) throw new LeaveError(404, "Leave not found.");
}

export async function listLeaves(companyId: string, opts: { from?: string; to?: string } = {}) {
  const cal = await getWorkCalendar(companyId);
  const where: Prisma.MisLeaveWhereInput = { companyId };
  if (opts.from && ISO.test(opts.from)) where.toDate = { gte: dateValue(opts.from) };
  if (opts.to && ISO.test(opts.to)) where.fromDate = { lte: dateValue(opts.to) };
  const [rows, staff, settings] = await Promise.all([
    prisma.misLeave.findMany({ where, orderBy: [{ fromDate: "desc" }, { createdAt: "desc" }], take: 1000 }),
    prisma.employee.findMany({
      where: { companyId, status: { not: "SUSPENDED" } },
      select: { id: true, firstName: true, lastName: true, email: true, misSaturdaysOff: true, misExtraSaturdayOff: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    getLeaveSettings(companyId),
  ]);
  const nameOf = new Map(staff.map((s) => [s.id, `${s.firstName} ${s.lastName}`.trim()]));
  const satOff = new Set(staff.filter((s) => s.misSaturdaysOff).map((s) => s.id));
  return {
    leaves: rows.map((r) => {
      const from = isoOf(r.fromDate);
      const to = isoOf(r.toDate);
      const submittedDate = r.submittedAt ? istDate(r.submittedAt) : null;
      return {
        id: r.id,
        employeeId: r.employeeId,
        employeeName: r.employeeId ? nameOf.get(r.employeeId) ?? null : null,
        personName: r.personName,
        email: r.email,
        from,
        to,
        workingDays: workingDaysIn(from, to, forPerson(cal, { misSaturdaysOff: !!r.employeeId && satOff.has(r.employeeId) })),
        type: r.type as LeaveType,
        status: r.status as LeaveStatus,
        leaveKind: r.leaveKind,
        reason: r.reason,
        note: r.note,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        noticeDays: submittedDate ? daysBetween(submittedDate, from) : null,
        source: r.source,
        editedInApp: r.editedInApp,
      };
    }),
    people: staff.map((s) => ({
      employeeId: s.id,
      name: `${s.firstName} ${s.lastName}`.trim(),
      username: s.email,
      saturdaysOff: s.misSaturdaysOff,
      saturdayRule: saturdayRuleOf(s),
    })),
    settings: { noticeDays: settings.noticeDays, lastReceivedAt: settings.lastReceivedAt?.toISOString() ?? null, lastSummary: settings.lastSummary },
  };
}

/** Which Saturdays a person has off: SECOND = the 2nd Saturday (everyone), TWO = the 2nd + one more each month, ALL = every Saturday. */
export type SaturdayRule = "SECOND" | "TWO" | "ALL";
export const SATURDAY_RULES: SaturdayRule[] = ["SECOND", "TWO", "ALL"];

export function saturdayRuleOf(e: { misSaturdaysOff: boolean; misExtraSaturdayOff?: boolean | null }): SaturdayRule {
  return e.misSaturdaysOff ? "ALL" : e.misExtraSaturdayOff ? "TWO" : "SECOND";
}

/** Set one person's Saturday rule (their personal MIS calendar). */
export async function setSaturdayRule(companyId: string, actorId: string, employeeId: string, rule: SaturdayRule) {
  const e = await checkPerson(companyId, employeeId);
  await prisma.employee.update({ where: { id: e!.id }, data: { misSaturdaysOff: rule === "ALL", misExtraSaturdayOff: rule === "TWO" } });
  await prisma.auditLog
    .create({ data: { companyId, employeeId: actorId, action: "MIS_SATURDAYS_OFF", metadata: { employeeId, name: `${e!.firstName} ${e!.lastName}`.trim(), rule } } })
    .catch(() => undefined);
}

/** Every Saturday off (or back to the 2nd Saturday only) — kept for older screens. */
export async function setSaturdaysOff(companyId: string, actorId: string, employeeId: string, off: boolean) {
  await setSaturdayRule(companyId, actorId, employeeId, off ? "ALL" : "SECOND");
}

// ---------------------------------------------------------------------------
// Used by the Circle Report, MIS Reports and the emails
// ---------------------------------------------------------------------------

export interface LeaveDay {
  leaveId: string;
  type: LeaveType;
  code: "OL" | "EL" | "A" | "SO";
  reason: string;
}

/** Approved leave per "employeeId|date" between two dates (inclusive). */
export async function leaveMap(companyId: string, from: string, to: string, employeeId?: string): Promise<Map<string, LeaveDay>> {
  const out = new Map<string, LeaveDay>();
  const rows = await prisma.misLeave
    .findMany({
      where: {
        companyId,
        status: "APPROVED",
        employeeId: employeeId ? employeeId : { not: null },
        fromDate: { lte: dateValue(to) },
        toDate: { gte: dateValue(from) },
      },
      orderBy: { createdAt: "asc" },
    })
    .catch(() => []);
  for (const r of rows) {
    const type = (LEAVE_TYPES.includes(r.type as LeaveType) ? r.type : "PLANNED") as LeaveType;
    const lf = isoOf(r.fromDate);
    const lt = isoOf(r.toDate);
    const asked = r.submittedAt
      ? ` — ${r.source === "REPORT" ? "intimation report of" : "asked on"} ${shortDate(istDate(r.submittedAt))}`
      : r.source === "MANUAL"
        ? " — added in MailPilot"
        : "";
    const reason = `${LEAVE_LABEL[type]} ${lf === lt ? shortDate(lf) : `${shortDate(lf)} – ${shortDate(lt)}`}${asked}${r.reason ? `: ${r.reason.slice(0, 120)}` : ""}.`;
    for (const d of expandDates(lf < from ? from : lf, lt > to ? to : lt)) {
      // An emergency leave over a planned one (or the other way round): the first record wins.
      if (!out.has(`${r.employeeId}|${d}`)) out.set(`${r.employeeId}|${d}`, { leaveId: r.id, type, code: LEAVE_CODE[type], reason });
    }
  }
  return out;
}

/** The Apps Script that connects the Google leave form to MailPilot. */
export function formScript(url: string, gid?: string): string {
  return `/**
 * MailPilot — sends every leave request to MailPilot.
 * 1. In the Google Sheet with the form responses: Extensions → Apps Script.
 * 2. Delete what is there, paste all of this, click Save (disk icon).
 * 3. Choose "setup" in the function list at the top, click Run, and allow access.
 * Done: new requests reach MailPilot in seconds, and the whole sheet is re-sent
 * every hour (so edits made in the sheet are picked up too).
 */
const MAILPILOT_URL = "${url}";
const RESPONSES_TAB_ID = ${gid && /^\d+$/.test(gid) ? gid : "null"}; // the tab with the form responses (null = first tab)

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendNewResponse").forSpreadsheet(SpreadsheetApp.getActive()).onFormSubmit().create();
  ScriptApp.newTrigger("sendAll").timeBased().everyHours(1).create();
  sendAll();
}

function responsesSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheets = ss.getSheets();
  if (RESPONSES_TAB_ID !== null) {
    for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === RESPONSES_TAB_ID) return sheets[i];
  }
  return sheets[0];
}

function toRows_(headers, values) {
  var tz = "Asia/Kolkata";
  return values
    .filter(function (r) { return r.some(function (v) { return v !== "" && v !== null; }); })
    .map(function (r) {
      var o = {};
      headers.forEach(function (h, i) {
        var v = r[i];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ss");
        if (String(h).trim()) o[String(h).trim()] = v;
      });
      return o;
    });
}

function send_(mode, rows) {
  var res = UrlFetchApp.fetch(MAILPILOT_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ mode: mode, rows: rows }),
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + " " + res.getContentText());
}

function sendAll() {
  var sh = responsesSheet_();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return;
  send_("sync", toRows_(data[0], data.slice(1)));
}

function sendNewResponse(e) {
  var sh = e.range.getSheet();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = sh.getRange(e.range.getRow(), 1, 1, sh.getLastColumn()).getValues();
  send_("submit", toRows_(headers, row));
}
`;
}
