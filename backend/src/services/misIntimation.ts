/**
 * Daily "Intimation Report" → leave records.
 *
 * HR keeps a small daily table (an Excel, shared as a screenshot/photo):
 *   1. Intimation Report <date> — Employee Name | Intimation of Leave / Half Day /
 *      Absent / WFH / Saturday Off | Inform Status | Reason | Replacement
 *   2. Advance Leave application received — Employee Name | Advance application
 *      form fill date | Advance Leave date | Inform Status | Reason | Replacement
 *
 * The photo is uploaded in MailPilot (Leave Records page). An AI vision model
 * only COPIES the cells exactly as written; everything else — dates, leave type,
 * who it is — is decided by the code below, so it is exact and testable:
 *   - Advance leave       → Planned (OL) if the form was filled ≥ noticeDays (2)
 *                           before the leave, else Emergency (EL)
 *   - Intimation of leave → Emergency leave (EL) for the dates written (or the
 *                           report date) — unless an approved leave already
 *                           covers those days (e.g. the advance application)
 *   - Saturday off        → SO for the report date
 *   - Absent / No intimation → A (absent) for the report date
 *   - Late / Half day / WFH / other → recorded only (the MIS is still needed)
 * Leave goes in straight away (HR can correct it on the Leave Records page).
 * The same leave on several days' reports is one record; uploading a report
 * again replaces what that report added.
 */
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/db";
import { invokeLLM, isGroqCoolingDown, VISION_MODEL } from "../lib/llm";
import { deleteMsiFiles, getMsiFile, makeMsiStorageKey, putMsiFile } from "../lib/msiStorage";
import { classifyLeave, getLeaveSettings, LeaveError, people, type LeaveType } from "./misLeave";
import { validateFile } from "./msiService";
import { addDaysTo, shortDate } from "./workCalendar";

// ---------------------------------------------------------------------------
// What the photo says (verbatim cells)
// ---------------------------------------------------------------------------

export interface ReadIntimation {
  name: string;
  type: string;
  status: string;
  reason: string;
  replacement: string;
}
export interface ReadAdvance {
  name: string;
  formDate: string;
  leaveDates: string;
  status: string;
  reason: string;
  replacement: string;
}
export interface ReadReport {
  title: string;
  intimations: ReadIntimation[];
  advance: ReadAdvance[];
}

const PROMPT = `This image is a daily "Intimation Report" table from an Indian company (dates are written day first, DD.MM.YYYY).
Copy every cell EXACTLY as written — do not interpret, correct or add anything. Return only JSON in this shape:
{"title":"<the title, e.g. Intimation Report 23.10.2026>",
 "intimations":[{"name":"","type":"","status":"","reason":"","replacement":""}],
 "advance":[{"name":"","formDate":"","leaveDates":"","status":"","reason":"","replacement":""}]}
"intimations" = the rows of the FIRST table (columns: Employee Name | Intimation of Leave/Half Day/Absent/WFH/Saturday Off | Inform Status | Reason of | Replacement).
"advance" = the rows under "Advance Leave application received" (columns: Employee Name | Advance application form fill date | Advance Leave date | Inform Status | Reason of | Replacement).
Leave out the S.NO column, header rows and empty rows. Use "" for an empty cell. If a cell's text wraps over several lines, join it with spaces.`;

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v == null ? "" : String(v).trim());

/** The model's answer → a clean ReadReport (tolerates thinking text / code fences around the JSON). */
export function parseReadReport(answer: string): ReadReport {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new LeaveError(422, "Couldn't read a table in that image. Please upload a clear screenshot of the Intimation Report.");
  let j: any;
  try {
    j = JSON.parse(text.slice(a, b + 1));
  } catch {
    throw new LeaveError(422, "Couldn't read a table in that image. Please upload a clear screenshot of the Intimation Report.");
  }
  const rows = (x: unknown) => (Array.isArray(x) ? x : []);
  return {
    title: str(j.title),
    intimations: rows(j.intimations)
      .map((r: any) => ({ name: str(r?.name), type: str(r?.type), status: str(r?.status), reason: str(r?.reason), replacement: str(r?.replacement) }))
      .filter((r) => r.name),
    advance: rows(j.advance)
      .map((r: any) => ({ name: str(r?.name), formDate: str(r?.formDate), leaveDates: str(r?.leaveDates), status: str(r?.status), reason: str(r?.reason), replacement: str(r?.replacement) }))
      .filter((r) => r.name),
  };
}

async function readImage(dataUrl: string): Promise<ReadReport> {
  if (!process.env.GROQ_API_KEY) throw new LeaveError(503, "Reading photos needs the AI key (GROQ_API_KEY) on the server.");
  if (isGroqCoolingDown()) throw new LeaveError(503, "The AI is busy right now (rate limit). Please try again in a few minutes.");
  try {
    const r = await invokeLLM({
      model: VISION_MODEL,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }],
    });
    return parseReadReport(r.choices?.[0]?.message?.content ?? "");
  } catch (e) {
    if (e instanceof LeaveError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[Intimation] reading the photo failed:", msg);
    if (/model.*(not found|decommission|does not exist)|404/i.test(msg))
      throw new LeaveError(503, `The AI model for photos (${VISION_MODEL}) isn't available any more — set GROQ_VISION_MODEL on the server to a current vision model.`);
    throw new LeaveError(502, "Couldn't read the photo just now. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Dates and names
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Every DD.MM.YYYY (also / - and 2-digit years) in a text, as YYYY-MM-DD, in order. */
export function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b/g)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const iso = `${y}-${pad(mo)}-${pad(d)}`;
    const t = new Date(`${iso}T00:00:00Z`);
    if (mo >= 1 && mo <= 12 && d >= 1 && t.getUTCDate() === d) out.push(iso);
  }
  return out;
}

/** "24.10.2026 to 26.10.2026" → one range; "26.10.2026 and 27.10.2026" → one range (consecutive); "1.11 and 5.11" → two. */
export function periodsIn(text: string): { from: string; to: string }[] {
  const dates = datesIn(text);
  if (!dates.length) return [];
  if (dates.length === 2 && /\b(to|till|until|upto|up to)\b|–|—|\s-\s/i.test(text) && dates[0] <= dates[1]) return [{ from: dates[0], to: dates[1] }];
  const sorted = [...new Set(dates)].sort();
  const out: { from: string; to: string }[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && addDaysTo(last.to, 1) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

/** "Mr. Gurmeet Singh" → "Gurmeet Singh", "Mrs. Shilpa Mam" → "Shilpa", "Mr. Mahender Ji" → "Mahender". */
export function cleanName(raw: string): string {
  return raw
    .replace(/^\s*(mr|mrs|ms|miss|dr|shri|smt)\.?\s+/i, "")
    .replace(/\s+(ji|mam|ma'am|maam|madam|sir)\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// What each row means
// ---------------------------------------------------------------------------

export type RowKind = "LEAVE" | "SATURDAY_OFF" | "ABSENT" | "LATE" | "HALF_DAY" | "WFH" | "OTHER";

export interface PlannedRow {
  section: "INTIMATION" | "ADVANCE";
  name: string;
  employeeId: string | null;
  matchedName: string | null;
  kind: RowKind;
  /** For leave-type rows: the leave to record. */
  leave: { type: LeaveType; from: string; to: string; submitted: string }[];
  /** Periods already covered by a recorded leave (this report is linked to it). */
  mentions: { from: string; to: string }[];
  /** Plain-English result shown to HR. */
  result: string;
  reason: string;
  replacement: string;
  raw: Record<string, string>;
}

export function kindOf(text: string): RowKind {
  const t = text.toLowerCase();
  if (/saturday\s*off/.test(t)) return "SATURDAY_OFF";
  if (/no\s*intimation|absent|without\s*(intimation|information)/.test(t)) return "ABSENT";
  if (/half\s*day/.test(t)) return "HALF_DAY";
  if (/\bwfh\b|work\s*from\s*home/.test(t)) return "WFH";
  if (/\blate\b/.test(t)) return "LATE";
  if (/leave/.test(t)) return "LEAVE";
  return "OTHER";
}

const KIND_TEXT: Record<RowKind, string> = {
  LEAVE: "Leave",
  SATURDAY_OFF: "Saturday off",
  ABSENT: "Absent",
  LATE: "Late — recorded (MIS still needed)",
  HALF_DAY: "Half day — recorded (MIS still needed)",
  WFH: "Work from home — recorded (MIS still needed)",
  OTHER: "Recorded",
};
const span = (f: string, t: string) => (f === t ? shortDate(f) : `${shortDate(f)} – ${shortDate(t)}`);

/**
 * Pure: what MailPilot does with each row of one report.
 * `covered(employeeId, from, to)` says whether an approved leave already covers those days.
 */
export function planReport(
  read: ReadReport,
  reportDate: string,
  noticeDays: number,
  match: (name: string) => { employeeId: string; name: string } | null,
  covered: (employeeId: string, from: string, to: string, section: "ADVANCE" | "INTIMATION") => boolean,
): PlannedRow[] {
  const out: PlannedRow[] = [];
  const advanceBy = new Map<string, { from: string; to: string }[]>();

  for (const a of read.advance) {
    const who = match(cleanName(a.name));
    const periods = periodsIn(a.leaveDates);
    const filled = datesIn(a.formDate)[0] ?? reportDate;
    const isCovered = (p: { from: string; to: string }) => !!who && covered(who.employeeId, p.from, p.to, "ADVANCE");
    const todo = periods.filter((p) => !isCovered(p));
    const leave = todo.map((p) => ({ type: classifyLeave(filled, p.from, noticeDays), from: p.from, to: p.to, submitted: filled }));
    if (who) advanceBy.set(who.employeeId, [...(advanceBy.get(who.employeeId) ?? []), ...periods]);
    const label = (l: { type: LeaveType; from: string; to: string }) => `${l.type === "PLANNED" ? "Planned leave" : "Emergency leave"} ${span(l.from, l.to)}`;
    out.push({
      section: "ADVANCE",
      name: a.name,
      employeeId: who?.employeeId ?? null,
      matchedName: who?.name ?? null,
      kind: "LEAVE",
      leave: who ? leave : [],
      mentions: who ? periods.filter(isCovered) : [],
      result: !periods.length
        ? "No leave dates found — not recorded"
        : !who
          ? `${periods.map((p) => span(p.from, p.to)).join(", ")} — person not found in MailPilot, not recorded`
          : [...leave.map(label), ...periods.filter(isCovered).map((p) => `Leave ${span(p.from, p.to)} — already recorded`)].join(", "),
      reason: a.reason,
      replacement: a.replacement,
      raw: { ...a },
    });
  }

  for (const r of read.intimations) {
    const who = match(cleanName(r.name));
    const kind = kindOf(`${r.type} ${r.status}`);
    let leave: PlannedRow["leave"] = [];
    let mentions: PlannedRow["mentions"] = [];
    let result = KIND_TEXT[kind];
    if (kind === "LEAVE") {
      const periods = periodsIn(`${r.type} ${r.status}`);
      const list = periods.length ? periods : [{ from: reportDate, to: reportDate }];
      const fromAdvance = who ? advanceBy.get(who.employeeId) ?? [] : [];
      const todo = list.filter(
        (p) => !(who && (fromAdvance.some((a) => a.from <= p.from && a.to >= p.to) || covered(who.employeeId, p.from, p.to, "INTIMATION"))),
      );
      leave = todo.map((p) => ({ type: classifyLeave(reportDate, p.from, noticeDays), from: p.from, to: p.to, submitted: reportDate }));
      mentions = list.filter((p) => !todo.includes(p));
      result = todo.length
        ? leave.map((l) => `${l.type === "PLANNED" ? "Planned leave" : "Emergency leave"} ${span(l.from, l.to)}`).join(", ")
        : `Leave ${list.map((p) => span(p.from, p.to)).join(", ")} — already recorded`;
    } else if (kind === "SATURDAY_OFF") {
      leave = [{ type: "SATURDAY_OFF", from: reportDate, to: reportDate, submitted: reportDate }];
      result = `Saturday off ${shortDate(reportDate)}`;
    } else if (kind === "ABSENT") {
      leave = [{ type: "ABSENT", from: reportDate, to: reportDate, submitted: reportDate }];
      result = `Absent ${shortDate(reportDate)}${/no\s*intimation/i.test(r.type) ? " (no intimation)" : ""}`;
    }
    out.push({
      section: "INTIMATION",
      name: r.name,
      employeeId: who?.employeeId ?? null,
      matchedName: who?.name ?? null,
      kind,
      leave: who ? leave : [],
      mentions: who ? mentions : [],
      result: who ? result : `${result} — person not found in MailPilot, not recorded`,
      reason: r.reason,
      replacement: r.replacement,
      raw: { ...r },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upload → read → record
// ---------------------------------------------------------------------------

const ADVANCE_KIND = "Advance leave application";
const keyOf = (employeeId: string, l: { type: LeaveType; from: string; to: string }) => `report|${employeeId}|${l.type}|${l.from}|${l.to}`;
const dv = (d: string) => new Date(`${d}T00:00:00.000Z`);
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** Undo what a report added (a leave stays while another report still mentions it). */
async function removeReportLeaves(companyId: string, reportDate: string) {
  const rows = await prisma.misLeave.findMany({ where: { companyId, source: "REPORT", editedInApp: false } });
  for (const r of rows) {
    const dates = ((r.raw as { reports?: string[] } | null)?.reports ?? []).filter((d) => d !== reportDate);
    if (dates.length === ((r.raw as { reports?: string[] } | null)?.reports ?? []).length) continue;
    if (dates.length) await prisma.misLeave.update({ where: { id: r.id }, data: { raw: { reports: dates } as Prisma.InputJsonValue } });
    else await prisma.misLeave.delete({ where: { id: r.id } });
  }
}

export async function uploadIntimationReport(
  companyId: string,
  actorId: string,
  input: { file: { fileName: string; dataBase64: string }; reportDate?: string | null },
) {
  let file;
  try {
    file = validateFile(input.file);
  } catch (e) {
    throw new LeaveError((e as { status?: number }).status ?? 400, e instanceof Error ? e.message : "Upload failed.");
  }
  if (!file.fileType.startsWith("image/")) throw new LeaveError(415, "Please upload a photo or screenshot (JPG or PNG).");
  const dataUrl = `data:${file.fileType};base64,${file.data.toString("base64")}`;
  const read = await readImage(dataUrl);
  if (!read.intimations.length && !read.advance.length) throw new LeaveError(422, "No rows found in that image. Please upload a clear screenshot of the Intimation Report.");

  const titleDate = datesIn(read.title)[0] ?? null;
  const reportDate = titleDate ?? (input.reportDate && /^\d{4}-\d{2}-\d{2}$/.test(input.reportDate) ? input.reportDate : null);
  if (!reportDate) throw new LeaveError(422, "Couldn't find the report's date in the image — choose the date and upload again.");

  const settings = await getLeaveSettings(companyId);
  const staff = await people(companyId);
  const { matchPersonByName } = await import("./misEmail");
  const match = (name: string) => {
    const p = name ? matchPersonByName(staff, name) : null;
    return p ? { employeeId: p.employeeId, name: p.name } : null;
  };

  // Start clean for this date (uploading the same day again replaces it).
  await removeReportLeaves(companyId, reportDate);
  const existing = await prisma.misLeave.findMany({
    where: { companyId, status: "APPROVED", employeeId: { not: null } },
    select: { employeeId: true, fromDate: true, toDate: true, source: true, leaveKind: true },
  });
  // An advance application is only "already recorded" by a form/manual leave or another advance row —
  // never by a same-day intimation (the advance one is the real, earlier request and replaces it).
  const covered = (emp: string, from: string, to: string, section: "ADVANCE" | "INTIMATION") =>
    existing.some(
      (l) =>
        l.employeeId === emp &&
        isoOf(l.fromDate) <= from &&
        isoOf(l.toDate) >= to &&
        (section === "INTIMATION" || l.source !== "REPORT" || l.leaveKind === ADVANCE_KIND),
    );

  const plan = planReport(read, reportDate, settings.noticeDays, match, covered);

  // Record the leave.
  let added = 0;
  for (const row of plan) {
    if (!row.employeeId) continue;
    for (const l of row.leave) {
      const formKey = keyOf(row.employeeId, l);
      const prev = await prisma.misLeave.findUnique({ where: { companyId_formKey: { companyId, formKey } } });
      const reports = [...new Set([...(((prev?.raw as { reports?: string[] } | null)?.reports) ?? []), reportDate])].sort();
      if (prev) {
        if (!prev.editedInApp) await prisma.misLeave.update({ where: { id: prev.id }, data: { raw: { reports } as Prisma.InputJsonValue } });
        continue;
      }
      let reportsMerged = reports;
      if (row.section === "ADVANCE") {
        // Same-day intimation leave already recorded inside this period: the advance application replaces it.
        const inside = await prisma.misLeave.findMany({
          where: { companyId, employeeId: row.employeeId, source: "REPORT", editedInApp: false, NOT: { leaveKind: ADVANCE_KIND }, fromDate: { gte: dv(l.from) }, toDate: { lte: dv(l.to) } },
        });
        for (const x of inside) reportsMerged = [...new Set([...reportsMerged, ...(((x.raw as { reports?: string[] } | null)?.reports) ?? [])])].sort();
        if (inside.length) await prisma.misLeave.deleteMany({ where: { id: { in: inside.map((x) => x.id) } } });
      }
      await prisma.misLeave.create({
        data: {
          companyId,
          employeeId: row.employeeId,
          personName: row.matchedName ?? row.name,
          fromDate: dv(l.from),
          toDate: dv(l.to),
          type: l.type,
          status: "APPROVED",
          leaveKind: row.section === "ADVANCE" ? ADVANCE_KIND : row.raw.type || null,
          reason: [row.reason && !/^nil$/i.test(row.reason) ? row.reason : null, row.replacement && !/^nil$/i.test(row.replacement) ? `Replacement: ${row.replacement}` : null]
            .filter(Boolean)
            .join(" · ") || null,
          submittedAt: new Date(`${l.submitted}T12:00:00+05:30`),
          source: "REPORT",
          formKey,
          editedInApp: false,
          raw: { reports: reportsMerged } as Prisma.InputJsonValue,
          updatedById: actorId,
        },
      });
      added++;
    }
  }

  // Link this report to leave it mentions that is already recorded by another report,
  // so that leave stays as long as any report still lists it.
  const reportLeaves = await prisma.misLeave.findMany({ where: { companyId, source: "REPORT", editedInApp: false } });
  for (const row of plan) {
    if (!row.employeeId) continue;
    for (const m of row.mentions) {
      for (const l of reportLeaves.filter((x) => x.employeeId === row.employeeId && isoOf(x.fromDate) <= m.from && isoOf(x.toDate) >= m.to)) {
        const reports = ((l.raw as { reports?: string[] } | null)?.reports) ?? [];
        if (!reports.includes(reportDate)) {
          reports.push(reportDate);
          await prisma.misLeave.update({ where: { id: l.id }, data: { raw: { reports: [...reports].sort() } as Prisma.InputJsonValue } });
        }
      }
    }
  }

  // Keep the image (evidence) and what was read.
  const key = makeMsiStorageKey(companyId);
  await putMsiFile(key, file.data);
  const old = await prisma.misIntimationReport.findUnique({ where: { companyId_reportDate: { companyId, reportDate: dv(reportDate) } } });
  const rows = plan.map(({ leave, ...r }) => ({ ...r, leave }));
  await prisma.misIntimationReport.upsert({
    where: { companyId_reportDate: { companyId, reportDate: dv(reportDate) } },
    create: { companyId, reportDate: dv(reportDate), fileName: file.fileName, fileType: file.fileType, storageReference: key, uploadedById: actorId, rows: rows as unknown as Prisma.InputJsonValue },
    update: { fileName: file.fileName, fileType: file.fileType, storageReference: key, uploadedById: actorId, rows: rows as unknown as Prisma.InputJsonValue },
  });
  if (old) await deleteMsiFiles([old.storageReference]).catch(() => undefined);
  await prisma.auditLog
    .create({ data: { companyId, employeeId: actorId, action: "MIS_INTIMATION_REPORT", metadata: { reportDate, rows: plan.length, leaveAdded: added } } })
    .catch(() => undefined);

  return {
    reportDate,
    dateFromImage: !!titleDate,
    rows: plan.map((r) => ({ section: r.section, name: r.name, matchedName: r.matchedName, kind: r.kind, result: r.result, reason: r.reason, replacement: r.replacement })),
    leaveAdded: added,
    unmatched: plan.filter((r) => !r.employeeId).map((r) => r.name),
  };
}

export async function listIntimationReports(companyId: string) {
  const reports = await prisma.misIntimationReport.findMany({ where: { companyId }, orderBy: { reportDate: "desc" }, take: 30 });
  return reports.map((r) => ({
    id: r.id,
    reportDate: isoOf(r.reportDate),
    fileName: r.fileName,
    uploadedAt: r.updatedAt.toISOString(),
    rows: ((r.rows as unknown as PlannedRow[]) ?? []).map((x) => ({ section: x.section, name: x.name, matchedName: x.matchedName, kind: x.kind, result: x.result, reason: x.reason, replacement: x.replacement })),
  }));
}

export async function deleteIntimationReport(companyId: string, id: string) {
  const r = await prisma.misIntimationReport.findFirst({ where: { id, companyId } });
  if (!r) throw new LeaveError(404, "Report not found.");
  await removeReportLeaves(companyId, isoOf(r.reportDate));
  await prisma.misIntimationReport.delete({ where: { id: r.id } });
  await deleteMsiFiles([r.storageReference]).catch(() => undefined);
}

export async function intimationImage(companyId: string, id: string) {
  const r = await prisma.misIntimationReport.findFirst({ where: { id, companyId } });
  if (!r) throw new LeaveError(404, "Report not found.");
  const data = await getMsiFile(r.storageReference);
  if (!data) throw new LeaveError(404, "The image is no longer available.");
  return { fileName: r.fileName, fileType: r.fileType, data };
}
