/**
 * Weekly reporters — people who send one report (a PDF) per week instead of
 * filling a daily MIS.
 *
 * The week is Monday–Saturday. Uploading the week's report any time up to
 * Saturday night (11:59 PM IST) counts as submitted for the WHOLE week: every
 * working day of it becomes NC (green) on the MIS Circle Report. If nothing is
 * uploaded by then, the week's last working day is ONE red circle (CM) and its
 * other working days show WK ("judged by the weekly report").
 *
 * The marks are written to MisCircleMark (source AUTO, locked) so they don't
 * depend on the file staying around; the weekly files themselves are kept
 * (MisWeeklyReport) and can be downloaded from the Circle Report page.
 * An HR mark on the Circle Report always wins.
 */
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/db";
import { deleteMsiFiles, getMsiFile, makeMsiStorageKey, putMsiFile } from "../lib/msiStorage";
import { fmtWhen } from "./misEvidence";
import { businessDateString, dateColumnValue, getMsiTimezone, startOfBusinessDay, validateFile } from "./msiService";
import { addDaysTo, forPerson, getWorkCalendar, isWorkingDay, shortDate, type WorkCalendar } from "./workCalendar";

export class WeeklyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Monday of the week that contains `date` ("YYYY-MM-DD"). */
export function weekStartOf(date: string): string {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDaysTo(date, -((wd + 6) % 7));
}

/** Monday … Saturday of a week. */
export const weekDays = (monday: string) => Array.from({ length: 6 }, (_, i) => addDaysTo(monday, i));

/** End of Saturday night (IST) — the upload deadline for the week. */
export const weekDeadline = (monday: string, tz: string = getMsiTimezone()) => startOfBusinessDay(addDaysTo(monday, 6), tz);

const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const span = (monday: string) => `${shortDate(monday)} – ${shortDate(addDaysTo(monday, 5))}`;

/** What each working day of a week should be marked, or null while the week is still open without a report. */
export function weekMarks(
  monday: string,
  report: { submittedAt: Date; fileName: string } | null,
  cal: WorkCalendar,
  since: string,
  now: Date,
  tz: string = getMsiTimezone(),
): { date: string; code: "NC" | "CM" | "WK"; reason: string }[] | null {
  const deadline = weekDeadline(monday, tz);
  const days = weekDays(monday).filter((d) => d >= since && isWorkingDay(d, cal));
  if (!days.length) return [];
  if (report && report.submittedAt < deadline) {
    const reason = `Weekly report uploaded ${fmtWhen(report.submittedAt.toISOString(), tz)} (${report.fileName}) — counts for the whole week ${span(monday)}.`;
    return days.map((date) => ({ date, code: "NC", reason }));
  }
  if (now < deadline) return null; // still time to upload
  const last = days[days.length - 1];
  const late = report ? ` It was uploaded late, on ${fmtWhen(report.submittedAt.toISOString(), tz)}.` : "";
  return days.map((date) =>
    date === last
      ? { date, code: "CM", reason: `Weekly report for ${span(monday)} was not uploaded by Saturday night (${shortDate(addDaysTo(monday, 5))}, 11:59 PM).${late}` }
      : { date, code: "WK", reason: `Weekly reporter — this week is judged by the weekly report; it was missed, so ${shortDate(last)} is the red circle.` },
  );
}

/** Weekly reporters of a company (or one person). */
async function weeklyPeople(companyId: string, employeeId?: string) {
  return prisma.employee.findMany({
    where: { companyId, misWeeklySince: { not: null }, status: { not: "SUSPENDED" }, ...(employeeId ? { id: employeeId } : {}) },
    select: { id: true, firstName: true, lastName: true, email: true, misWeeklySince: true, misSaturdaysOff: true },
  });
}

/** Writes the Circle Report marks for the last few weeks of every weekly reporter. */
export async function recordWeeklyMarks(companyId: string, now: Date = new Date(), employeeId?: string): Promise<number> {
  let people;
  try {
    people = await weeklyPeople(companyId, employeeId);
  } catch {
    return 0; // column not there yet (first boot)
  }
  if (!people.length) return 0;
  const tz = getMsiTimezone();
  const companyCal = await getWorkCalendar(companyId);
  const today = businessDateString(now, tz);
  let written = 0;
  for (const p of people) {
    const since = isoOf(p.misWeeklySince!);
    const cal = forPerson(companyCal, p);
    const first = weekStartOf(since > addDaysTo(today, -42) ? since : addDaysTo(today, -42));
    const reports = await prisma.misWeeklyReport.findMany({
      where: { employeeId: p.id, weekStart: { gte: dateColumnValue(first) } },
      select: { weekStart: true, submittedAt: true, fileName: true },
    });
    const byWeek = new Map(reports.map((r) => [isoOf(r.weekStart), r]));
    for (let monday = first; monday <= today; monday = addDaysTo(monday, 7)) {
      const marks = weekMarks(monday, byWeek.get(monday) ?? null, cal, since, now, tz);
      if (marks === null) {
        // Week still open and no report: clear any old automatic marks (e.g. a report deleted by HR).
        await prisma.misCircleMark.deleteMany({ where: { employeeId: p.id, source: "AUTO", date: { in: weekDays(monday).map(dateColumnValue) } } });
        continue;
      }
      for (const m of marks) {
        const where = { employeeId_date: { employeeId: p.id, date: dateColumnValue(m.date) } };
        const existing = await prisma.misCircleMark.findUnique({ where });
        if (existing?.source === "MANUAL") {
          if (existing.autoCode !== m.code || existing.reason !== m.reason) await prisma.misCircleMark.update({ where, data: { autoCode: m.code, reason: m.reason } });
          continue;
        }
        if (existing && existing.code === m.code && existing.reason === m.reason) continue;
        await prisma.misCircleMark.upsert({
          where,
          create: { companyId, employeeId: p.id, date: dateColumnValue(m.date), code: m.code, autoCode: m.code, source: "AUTO", reason: m.reason, evidence: Prisma.DbNull, finalAt: now },
          update: { code: m.code, autoCode: m.code, source: "AUTO", reason: m.reason, evidence: Prisma.DbNull, finalAt: now },
        });
        written++;
      }
    }
  }
  return written;
}

/** Weekly reporters with their recent weekly reports — for the Circle Report page. */
export async function listWeekly(companyId: string, now: Date = new Date()) {
  const tz = getMsiTimezone();
  const today = businessDateString(now, tz);
  const thisWeek = weekStartOf(today);
  const people = await weeklyPeople(companyId);
  const reports = people.length
    ? await prisma.misWeeklyReport.findMany({
        where: { employeeId: { in: people.map((p) => p.id) }, weekStart: { gte: dateColumnValue(addDaysTo(thisWeek, -7 * 12)) } },
        orderBy: { weekStart: "desc" },
        select: { id: true, employeeId: true, weekStart: true, fileName: true, fileSize: true, submittedAt: true },
      })
    : [];
  return {
    thisWeek,
    thisWeekLabel: span(thisWeek),
    deadline: weekDeadline(thisWeek, tz).toISOString(),
    people: people.map((p) => {
      const mine = reports.filter((r) => r.employeeId === p.id);
      return {
        employeeId: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        login: p.email,
        since: isoOf(p.misWeeklySince!),
        reports: mine.map((r) => {
          const w = isoOf(r.weekStart);
          return {
            id: r.id,
            weekStart: w,
            week: span(w),
            fileName: r.fileName,
            fileSize: r.fileSize,
            submittedAt: r.submittedAt.toISOString(),
            onTime: r.submittedAt < weekDeadline(w, tz),
          };
        }),
      };
    }),
  };
}

/** Make someone a weekly reporter (from today) or a daily one again. */
export async function setWeekly(companyId: string, actorId: string, employeeId: string, on: boolean, now: Date = new Date()) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, companyId }, select: { id: true, firstName: true, lastName: true, misWeeklySince: true } });
  if (!e) throw new WeeklyError(404, "Person not found.");
  if (on && e.misWeeklySince) return;
  // Starts with the current week, so this week's report already counts.
  const since = on ? weekStartOf(businessDateString(now)) : null;
  await prisma.employee.update({ where: { id: e.id }, data: { misWeeklySince: since ? dateColumnValue(since) : null } });
  if (!on) await prisma.misCircleMark.deleteMany({ where: { employeeId: e.id, source: "AUTO", code: { in: ["WK"] } } });
  await prisma.auditLog
    .create({ data: { companyId, employeeId: actorId, action: "MIS_WEEKLY_REPORTER", metadata: { employeeId, name: `${e.firstName} ${e.lastName}`.trim(), on, since } } })
    .catch(() => undefined);
  if (on) await recordWeeklyMarks(companyId, now, e.id);
}

/** Upload (or replace) this week's report for a weekly reporter. */
export async function uploadWeeklyReport(
  companyId: string,
  actorId: string,
  input: { employeeId: string; file: { fileName: string; dataBase64: string } },
  now: Date = new Date(),
) {
  const p = (await weeklyPeople(companyId, input.employeeId))[0];
  if (!p) throw new WeeklyError(400, "This person isn't a weekly reporter yet — switch on \"Weekly report\" for them first.");
  let file;
  try {
    file = validateFile(input.file);
  } catch (e) {
    throw new WeeklyError((e as { status?: number }).status ?? 400, e instanceof Error ? e.message : "Upload failed.");
  }
  const monday = weekStartOf(businessDateString(now));
  const key = makeMsiStorageKey(companyId);
  await putMsiFile(key, file.data);
  const where = { employeeId_weekStart: { employeeId: p.id, weekStart: dateColumnValue(monday) } };
  const old = await prisma.misWeeklyReport.findUnique({ where });
  try {
    await prisma.misWeeklyReport.upsert({
      where,
      // submittedAt is when the week was first covered; a replacement keeps it.
      create: { companyId, employeeId: p.id, weekStart: dateColumnValue(monday), fileName: file.fileName, fileType: file.fileType, fileSize: file.data.length, storageReference: key, submittedAt: now, uploadedById: actorId },
      update: { fileName: file.fileName, fileType: file.fileType, fileSize: file.data.length, storageReference: key, uploadedById: actorId },
    });
  } catch (e) {
    await deleteMsiFiles([key]).catch(() => undefined);
    throw e;
  }
  if (old) await deleteMsiFiles([old.storageReference]).catch(() => undefined);
  await prisma.auditLog
    .create({ data: { companyId, employeeId: actorId, action: "MIS_WEEKLY_REPORT_UPLOADED", metadata: { employeeId: p.id, weekStart: monday, fileName: file.fileName, replaced: !!old } } })
    .catch(() => undefined);
  await recordWeeklyMarks(companyId, now, p.id);
  return { weekStart: monday, week: span(monday), onTime: (old?.submittedAt ?? now) < weekDeadline(monday) };
}

export async function deleteWeeklyReport(companyId: string, actorId: string, id: string, now: Date = new Date()) {
  const r = await prisma.misWeeklyReport.findFirst({ where: { id, companyId } });
  if (!r) throw new WeeklyError(404, "Report not found.");
  await prisma.misWeeklyReport.delete({ where: { id: r.id } });
  await deleteMsiFiles([r.storageReference]).catch(() => undefined);
  await prisma.auditLog
    .create({ data: { companyId, employeeId: actorId, action: "MIS_WEEKLY_REPORT_DELETED", metadata: { employeeId: r.employeeId, weekStart: isoOf(r.weekStart), fileName: r.fileName } } })
    .catch(() => undefined);
  await recordWeeklyMarks(companyId, now, r.employeeId);
}

export async function weeklyReportFile(companyId: string, id: string) {
  const r = await prisma.misWeeklyReport.findFirst({ where: { id, companyId } });
  if (!r) throw new WeeklyError(404, "Report not found.");
  const data = await getMsiFile(r.storageReference);
  if (!data) throw new WeeklyError(404, "The file is no longer available.");
  return { fileName: r.fileName, fileType: r.fileType, data };
}

/** Every company with weekly reporters: write the marks (scheduler). */
export async function recordAllWeeklyMarks(now: Date = new Date()) {
  let companies: { companyId: string }[] = [];
  try {
    companies = await prisma.employee.findMany({ where: { misWeeklySince: { not: null } }, select: { companyId: true }, distinct: ["companyId"] });
  } catch {
    return;
  }
  for (const c of companies) await recordWeeklyMarks(c.companyId, now).catch((e) => console.error("[MIS weekly] marks failed:", e instanceof Error ? e.message : e));
}
