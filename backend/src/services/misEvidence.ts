/**
 * Evidence behind every Circle Report cell — so HR can show WHEN and WHY a red
 * circle was marked:
 *
 *   - the deadline (end of the next working day after the MIS day),
 *   - what MailPilot saw at the deadline (status, filled / blank entries),
 *   - when MailPilot read the file, and when the employee last SAVED the
 *     Excel file before that (time + who, from OneDrive / SharePoint),
 *   - when entries for the day first appeared, when it was fully filled,
 *   - and whether it was filled late (after the deadline).
 *
 * Built from MisCheckEvent rows (one per change MailPilot saw) and stored on
 * the MisCircleMark, so it survives after the raw events are purged.
 *
 * Timing rule: an event's "effective time" is the file's last save if that is
 * not later than when MailPilot read it (the content can't have changed after
 * the last save), otherwise the read time. So even if MailPilot only read the
 * file later, a file saved before the deadline counts as on time.
 */
import { prisma } from "../lib/db";
import { addDays, getMsiTimezone, startOfBusinessDay } from "./msiService";
import { nextWorkingDay, shortDate, type WorkCalendar } from "./workCalendar";

export interface RawEvent {
  sourceId: string;
  sourceLabel: string;
  at: Date;
  status: string;
  filledCount: number;
  blankCount: number;
  fileModifiedAt: Date | null;
  fileModifiedBy: string | null;
  note: string | null;
}

export interface EvidenceEvent {
  /** When MailPilot read the file. */
  at: string;
  /** The Excel file's last save at that moment, and by whom. */
  savedAt: string | null;
  savedBy: string | null;
  status: string;
  filled: number;
  blanks: number;
  file: string;
  note: string | null;
  /** Effective time (see the timing rule) is after the deadline. */
  afterDeadline: boolean;
}

export interface DeadlineState {
  status: string;
  filled: number;
  blanks: number;
  /** When MailPilot read it. */
  checkedAt: string;
  /** Excel last saved before that, and by whom. */
  savedAt: string | null;
  savedBy: string | null;
  note: string | null;
}

export interface CircleEvidence {
  /** Last day to fill (the next working day), "YYYY-MM-DD". */
  deadlineDay: string;
  /** End of that day — the exact deadline instant. */
  deadline: string;
  /** What the MIS looked like at the deadline. Null = MailPilot didn't read the file before it. */
  atDeadline: DeadlineState | null;
  /** When entries for the day first appeared. */
  firstFilledAt: string | null;
  /** When every usual entry was filled. */
  completedAt: string | null;
  /** Filled only after the deadline (while it was a red circle at the deadline). */
  filledLateAt: string | null;
  /** Latest save of the Excel file MailPilot knows of, and by whom. */
  lastSavedAt: string | null;
  lastSavedBy: string | null;
  /** Every change MailPilot saw, oldest first (at most 20). */
  timeline: EvidenceEvent[];
  /** Ready-to-show sentences (business time zone). */
  lines: string[];
}

/** The exact moment a day's MIS stops being "pending": end of the next working day. */
export function deadlineFor(date: string, cal: WorkCalendar, tz: string = getMsiTimezone()): { day: string; at: Date } {
  const day = nextWorkingDay(date, cal);
  return { day, at: startOfBusinessDay(addDays(day, 1), tz) };
}

/** "05-10-2026 06:02 PM" in the business time zone. */
export function fmtWhen(d: Date | string | null | undefined, tz: string = getMsiTimezone()): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}-${g("month")}-${g("year")} ${g("hour")}:${g("minute")} ${g("dayPeriod").toUpperCase()}`;
}

const effective = (e: RawEvent) => (e.fileModifiedAt && e.fileModifiedAt <= e.at ? e.fileModifiedAt : e.at);

const STATUS_TEXT: Record<string, string> = {
  COMPLETE: "submitted (every usual entry filled)",
  INCOMPLETE: "filled with a few usual entries blank",
  MISSING: "not filled",
  ERROR: "file couldn't be read",
  OFF: "day off",
  NOT_CHECKED: "not checked",
};
export const statusText = (s: string) => STATUS_TEXT[s] ?? s.toLowerCase();

/** Same order as the MIS status of a person with several files. */
function combine(statuses: string[]): string {
  const s = statuses.filter((x) => x !== "OFF");
  if (!s.length) return "OFF";
  if (s.every((x) => x === "COMPLETE")) return "COMPLETE";
  if (s.includes("INCOMPLETE")) return "INCOMPLETE";
  if (s.includes("MISSING")) return "MISSING";
  if (s.includes("ERROR")) return "ERROR";
  return "NOT_CHECKED";
}

/** Builds the evidence for one person and one MIS day from the change log. */
export function buildEvidence(
  events: RawEvent[],
  deadline: { day: string; at: Date },
  tz: string = getMsiTimezone(),
  now: Date = new Date(),
): CircleEvidence {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const bySource = new Map<string, RawEvent[]>();
  for (const e of sorted) bySource.set(e.sourceId, [...(bySource.get(e.sourceId) ?? []), e]);

  // State at the deadline: the latest change per file whose effective time is not after it.
  let atDeadline: DeadlineState | null = null;
  if (bySource.size) {
    const states = [...bySource.values()].map((list) => list.filter((e) => effective(e) <= deadline.at).at(-1) ?? null);
    if (states.every((x): x is RawEvent => x !== null)) {
      const latest = states.reduce((a, b) => (a.at > b.at ? a : b));
      const saved = states.map((x) => x.fileModifiedAt).filter((x): x is Date => !!x && x <= deadline.at);
      const savedAt = saved.length ? new Date(Math.max(...saved.map((x) => x.getTime()))) : null;
      atDeadline = {
        status: combine(states.map((x) => x.status)),
        filled: states.reduce((n, x) => n + x.filledCount, 0),
        blanks: states.reduce((n, x) => n + x.blankCount, 0),
        checkedAt: latest.at.toISOString(),
        savedAt: savedAt?.toISOString() ?? null,
        savedBy: savedAt ? states.find((x) => x.fileModifiedAt?.getTime() === savedAt.getTime())?.fileModifiedBy ?? null : null,
        note: states.length === 1 ? states[0].note : states.map((x) => `${x.sourceLabel}: ${x.note ?? statusText(x.status)}`).join(" | "),
      };
    }
  }

  const firstFilled = sorted.filter((e) => e.filledCount > 0).map(effective);
  const firstFilledAt = firstFilled.length ? new Date(Math.min(...firstFilled.map((d) => d.getTime()))) : null;

  // Fully filled = every file reached COMPLETE; the moment the last one did.
  let completedAt: Date | null = null;
  if (bySource.size) {
    const perFile = [...bySource.values()].map((list) => list.find((e) => e.status === "COMPLETE"));
    if (perFile.every((x): x is RawEvent => !!x)) completedAt = new Date(Math.max(...perFile.map((x) => effective(x).getTime())));
  }

  const wasRedAtDeadline = atDeadline?.status === "MISSING";
  const late = wasRedAtDeadline ? sorted.find((e) => e.filledCount > 0 && effective(e) > deadline.at) : undefined;

  const saves = sorted.filter((e) => e.fileModifiedAt);
  const lastSave = saves.length ? saves.reduce((a, b) => (a.fileModifiedAt! >= b.fileModifiedAt! ? a : b)) : null;

  const timeline: EvidenceEvent[] = sorted.slice(-20).map((e) => ({
    at: e.at.toISOString(),
    savedAt: e.fileModifiedAt?.toISOString() ?? null,
    savedBy: e.fileModifiedBy,
    status: e.status,
    filled: e.filledCount,
    blanks: e.blankCount,
    file: e.sourceLabel,
    note: e.note,
    afterDeadline: effective(e) > deadline.at,
  }));

  const ev: CircleEvidence = {
    deadlineDay: deadline.day,
    deadline: deadline.at.toISOString(),
    atDeadline,
    firstFilledAt: firstFilledAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
    filledLateAt: late ? effective(late).toISOString() : null,
    lastSavedAt: lastSave?.fileModifiedAt?.toISOString() ?? null,
    lastSavedBy: lastSave?.fileModifiedBy ?? null,
    timeline,
    lines: [],
  };
  ev.lines = evidenceLines(ev, tz, now);
  return ev;
}

/** Plain sentences for the app, the Excel and HR. */
export function evidenceLines(ev: CircleEvidence, tz: string = getMsiTimezone(), now: Date = new Date()): string[] {
  const f = (d: string | null) => fmtWhen(d, tz);
  const passed = now >= new Date(ev.deadline);
  const lines = [`Deadline: end of ${shortDate(ev.deadlineDay)} (${f(new Date(new Date(ev.deadline).getTime() - 60_000).toISOString())}).`];
  const d = ev.atDeadline;
  if (d) {
    const counts = d.status === "COMPLETE" ? `${d.filled} entries filled` : `${d.filled} filled, ${d.blanks} usual entr${d.blanks === 1 ? "y" : "ies"} blank`;
    lines.push(
      `${passed ? "At the deadline" : "So far"}: ${statusText(d.status)} — ${counts}. MailPilot read the file at ${f(d.checkedAt)}${
        d.savedAt ? `; the Excel file had last been saved at ${f(d.savedAt)}${d.savedBy ? ` by ${d.savedBy}` : ""}` : ""
      }.`,
    );
  } else if (passed) {
    lines.push("MailPilot did not read the file before the deadline (the server was asleep or the file couldn't be read), so the result is based on the first read after it.");
  }
  if (ev.firstFilledAt) lines.push(`Entries for this day first appeared: ${f(ev.firstFilledAt)}.`);
  else lines.push("No entries for this day were ever seen in the file.");
  if (ev.completedAt) lines.push(`Every usual entry filled: ${f(ev.completedAt)}.`);
  if (ev.filledLateAt) lines.push(`Filled late: ${f(ev.filledLateAt)} — after the deadline, so the red circle stays.`);
  if (ev.lastSavedAt) lines.push(`Excel file last saved (latest known): ${f(ev.lastSavedAt)}${ev.lastSavedBy ? ` by ${ev.lastSavedBy}` : ""}.`);
  return lines;
}

/** The change log for these people and days: "employeeId|date" -> events. */
export async function loadEvents(companyId: string, dates: string[], employeeId?: string): Promise<Map<string, RawEvent[]>> {
  const out = new Map<string, RawEvent[]>();
  if (!dates.length) return out;
  const [rows, sources] = await Promise.all([
    prisma.misCheckEvent.findMany({
      where: { companyId, checkDate: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) }, ...(employeeId ? { employeeId } : {}) },
      orderBy: { at: "asc" },
    }),
    prisma.misSource.findMany({ where: { companyId, ...(employeeId ? { employeeId } : {}) }, select: { id: true, label: true, fileName: true } }),
  ]);
  const label = new Map(sources.map((s) => [s.id, s.label || s.fileName || "MIS file"]));
  for (const r of rows) {
    const k = `${r.employeeId}|${r.checkDate.toISOString().slice(0, 10)}`;
    const list = out.get(k) ?? [];
    list.push({
      sourceId: r.sourceId,
      sourceLabel: label.get(r.sourceId) ?? "MIS file (removed)",
      at: r.at,
      status: r.status,
      filledCount: r.filledCount,
      blankCount: r.blankCount,
      fileModifiedAt: r.fileModifiedAt,
      fileModifiedBy: r.fileModifiedBy,
      note: r.note,
    });
    out.set(k, list);
  }
  return out;
}

/** Reason sentence from the state at the deadline. */
export function reasonAtDeadline(d: DeadlineState): string {
  switch (d.status) {
    case "MISSING":
      return `${(d.note ?? "Not filled").replace(/\.$/, "")} — still the case at the deadline.`;
    case "INCOMPLETE":
      return `Filled, but ${d.blanks} usual entr${d.blanks === 1 ? "y was" : "ies were"} still blank at the deadline.`;
    case "COMPLETE":
      return `Submitted before the deadline — every usual entry filled (${d.filled}).`;
    default:
      return statusText(d.status);
  }
}
