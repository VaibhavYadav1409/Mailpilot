/**
 * MIS emails — two emails on every working day, about the LAST WORKING DAY's
 * MIS (deadline: 11:00 AM on the next working day, MIS_DEADLINE_TIME):
 *
 *   1. WARNING (default 9:30 AM) — only to people whose MIS for that day is
 *      not submitted or incomplete: "submit it before 11:00 AM, or a red circle
 *      is marked", with the blank cells listed.
 *   2. RESULT (at the deadline, 11:00 AM) — to everyone, after re-reading the
 *      files and locking the day: red circle marked (not submitted), yellow
 *      (incomplete — no circle) or green (submitted — no circle), plus the
 *      month's red circles and salary deduction. HR gets one summary table.
 *
 * Nothing is sent on days off: the deadline only falls on working days.
 *
 * Sending is free:
 *   - "graph" (default): Microsoft Graph sendMail from the Microsoft 365
 *     account MailPilot already uses for the MIS files (contactus@…). Needs the
 *     Mail.Send permission ("Allow sending"). A copy of every email stays in
 *     that mailbox's Sent Items.
 *   - "brevo": Brevo's free HTTP API (300 emails/day), MIS_EMAIL_DRIVER=brevo,
 *     BREVO_API_KEY, MIS_EMAIL_FROM.
 *   - "console": only writes to the server log (testing).
 * Render's free plan blocks SMTP ports, so plain SMTP is not an option there.
 *
 * Triggers (safe together — each email goes out once per day):
 *   - the backend's own scheduler (checks every 5 minutes);
 *   - optional outside timer (cron-job.org) calling
 *     /api/mis/email/cron/<token>?type=warn|result at the right times.
 */
import crypto from "node:crypto";
import { prisma } from "../lib/db";
import { Prisma } from "../generated/prisma/client";
import { MisGraphError, getMisAccessToken, scopesAllowMail, sendGraphMail } from "./misMicrosoft";
import { getMisStatusForDate, matchExistingStaff, misFocusDates, runMisChecks, type MisEmployeeDay } from "./misService";
import { CIRCLES_PER_DEDUCTION, deductionCalculation, getCircleMonth, recordAutoMarks, redCircleEntries, type CircleCell } from "./misCircle";
import { deadlineFor, fmtWhen } from "./misEvidence";
import { businessDateString, getMsiTimezone } from "./msiService";
import { addDaysTo, deadlineClock, getWorkCalendar, shortDate } from "./workCalendar";

export class MisEmailError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type EmailTrigger = "SCHEDULE" | "CRON" | "MANUAL" | "TEST";
export type EmailKind = "WARN" | "RESULT";

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s.trim());
const SEND_GAP_MS = Number(process.env.MIS_EMAIL_GAP_MS ?? 2500); // Exchange allows 30 messages a minute
/** How late the backend's own timer may still send (e.g. the server was asleep). */
const WARN_WINDOW_MIN = 90;
const RESULT_WINDOW_MIN = 180;

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getEmailSettings(companyId: string) {
  const existing = await prisma.misEmailSettings.findUnique({ where: { companyId } });
  if (existing) return existing;
  return prisma.misEmailSettings.upsert({
    where: { companyId },
    create: { companyId, cronToken: crypto.randomBytes(24).toString("hex") },
    update: {},
  });
}

export interface EmailSettingsInput {
  enabled?: boolean;
  warnEnabled?: boolean;
  warnTime?: string;
  resultEnabled?: boolean;
  audience?: "ALL" | "ISSUES";
  skipOffDays?: boolean;
  hrSummary?: boolean;
  hrEmails?: string | null;
  subject?: string | null;
  intro?: string | null;
  footer?: string | null;
}

export function parseEmailList(raw: string | null | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(/[,;\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export async function updateEmailSettings(companyId: string, actorId: string, input: EmailSettingsInput) {
  await getEmailSettings(companyId);
  if (input.warnTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.warnTime)) throw new MisEmailError(400, "Warning time must be HH:mm, e.g. 09:30.");
  if (input.audience !== undefined && !["ALL", "ISSUES"].includes(input.audience)) throw new MisEmailError(400, "Unknown audience.");
  let hrEmails: string | null | undefined = undefined;
  if (input.hrEmails !== undefined) {
    const list = parseEmailList(input.hrEmails);
    const bad = list.filter((e) => !isEmail(e));
    if (bad.length) throw new MisEmailError(400, `Not an email address: ${bad.join(", ")}`);
    hrEmails = list.join(", ") || null;
  }
  const clean = (v: string | null | undefined, max: number) => (v === undefined ? undefined : v?.trim() ? v.trim().slice(0, max) : null);
  return prisma.misEmailSettings.update({
    where: { companyId },
    data: {
      enabled: input.enabled,
      warnEnabled: input.warnEnabled,
      warnTime: input.warnTime,
      resultEnabled: input.resultEnabled,
      audience: input.audience,
      skipOffDays: input.skipOffDays,
      hrSummary: input.hrSummary,
      hrEmails,
      subject: clean(input.subject, 150),
      intro: clean(input.intro, 2000),
      footer: clean(input.footer, 1000),
      updatedById: actorId,
    },
  });
}

export async function rotateCronToken(companyId: string) {
  await getEmailSettings(companyId);
  return prisma.misEmailSettings.update({ where: { companyId }, data: { cronToken: crypto.randomBytes(24).toString("hex") } });
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

const driver = () => (process.env.MIS_EMAIL_DRIVER ?? "graph").toLowerCase();

export interface SenderStatus {
  driver: string;
  from: string | null;
  canSend: boolean;
  problem: string | null;
  /** Reconnecting the Microsoft account would fix it. */
  needsReconnect: boolean;
}

export async function senderStatus(companyId: string): Promise<SenderStatus> {
  const d = driver();
  if (d === "console") return { driver: d, from: "server log", canSend: true, problem: "Test mode — emails are only written to the server log (MIS_EMAIL_DRIVER=console).", needsReconnect: false };
  if (d === "brevo") {
    const from = process.env.MIS_EMAIL_FROM ?? null;
    const ok = !!process.env.BREVO_API_KEY && !!from;
    return { driver: d, from, canSend: ok, problem: ok ? null : "Set BREVO_API_KEY and MIS_EMAIL_FROM on the server.", needsReconnect: false };
  }
  const conn = await prisma.misConnection.findUnique({ where: { companyId } });
  if (!conn) return { driver: "graph", from: null, canSend: false, problem: "Connect the Microsoft 365 account first (Employees → MIS staff).", needsReconnect: true };
  if (conn.status === "NEEDS_RECONNECT")
    return { driver: "graph", from: conn.accountEmail, canSend: false, problem: `Microsoft access for ${conn.accountEmail} expired — connect it again.`, needsReconnect: true };
  if (!scopesAllowMail(conn.scopes))
    return {
      driver: "graph",
      from: conn.accountEmail,
      canSend: false,
      problem: `${conn.accountEmail} can read the MIS files but isn't allowed to send email yet. Click "Allow sending" and sign in once more as ${conn.accountEmail}.`,
      needsReconnect: true,
    };
  return { driver: "graph", from: conn.accountEmail, canSend: true, problem: null, needsReconnect: false };
}

interface OutMail {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
}

async function deliver(companyId: string, msg: OutMail): Promise<void> {
  const d = driver();
  if (d === "console") {
    console.log(`[MIS email:console] To: ${msg.to.join(", ")} | Subject: ${msg.subject}\n${msg.text}`);
    return;
  }
  if (d === "brevo") {
    const from = process.env.MIS_EMAIL_FROM ?? "";
    const m = /^(.*)<(.+)>$/.exec(from.trim());
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY ?? "", "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: m ? { name: m[1].trim().replace(/^"|"$/g, ""), email: m[2].trim() } : { email: from.trim() },
        to: msg.to.map((email) => ({ email })),
        ...(msg.cc?.length ? { cc: msg.cc.map((email) => ({ email })) } : {}),
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
      }),
    });
    if (!res.ok) throw new MisEmailError(res.status, `Brevo couldn't send the email: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  const token = await getMisAccessToken(companyId);
  await sendGraphMail(token, msg);
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export interface Recipient {
  employeeId: string;
  name: string;
  username: string;
  email: string | null;
  /** Where the address came from. */
  emailSource: "CONTACT" | "LOGIN" | null;
  hasMis: boolean;
}

/** Everyone on the Circle Report (MIS staff + anyone with an MIS file), with the address their MIS email goes to. */
export async function listRecipients(companyId: string): Promise<Recipient[]> {
  const people = await prisma.employee.findMany({
    where: {
      companyId,
      OR: [{ NOT: { email: { contains: "@" } }, status: { not: "SUSPENDED" } }, { misSources: { some: {} } }],
    },
    select: { id: true, firstName: true, lastName: true, email: true, contactEmail: true, _count: { select: { misSources: true } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return people.map((p) => {
    const login = p.email.includes("@") ? p.email : null;
    return {
      employeeId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      username: p.email.toUpperCase(),
      email: p.contactEmail ?? login,
      emailSource: p.contactEmail ? "CONTACT" : login ? "LOGIN" : null,
      hasMis: p._count.misSources > 0,
    };
  });
}

/** "a@x.com, b@y.com" -> the cleaned list to store (one person can have several addresses). */
export function cleanAddressList(raw: string | null | undefined): { value: string | null; bad: string[] } {
  const list = parseEmailList(raw);
  const bad = list.filter((e) => !isEmail(e));
  return { value: list.length ? list.join(", ") : null, bad };
}

export async function setRecipientEmail(companyId: string, employeeId: string, email: string | null) {
  const { value, bad } = cleanAddressList(email);
  if (bad.length) throw new MisEmailError(400, `Not an email address: ${bad.join(", ")}`);
  const { count } = await prisma.employee.updateMany({ where: { id: employeeId, companyId }, data: { contactEmail: value } });
  if (!count) throw new MisEmailError(404, "Person not found.");
}

/** Edit distance, for names typed slightly differently ("Deepskhikha" ~ "Deepshikha"). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The one person a pasted name means: login, full name, first name, or a first name with a small typo. Null when unsure. */
export function matchPersonByName<T extends { name: string; email: string }>(staff: T[], raw: string): T | null {
  const name = raw.trim();
  const lower = name.toLowerCase();
  const word = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const firstOf = (s: string) => word(s.trim().split(/\s+/)[0] ?? "");
  const one = (list: T[]) => (list.length === 1 ? list[0] : null);
  return (
    matchExistingStaff(staff, name) ??
    staff.find((p) => p.name.toLowerCase() === lower) ??
    one(staff.filter((p) => firstOf(p.name) === firstOf(name) || word(p.email) === firstOf(name))) ??
    one(
      staff.filter((p) => {
        const a = firstOf(name);
        const b = firstOf(p.name);
        return a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 2;
      }),
    )
  );
}

/** Pasted "Name <tab> email" rows -> contact emails, matched by login or name. */
export async function bulkSetEmails(companyId: string, rows: { name: string; email: string }[]) {
  const people = await listRecipients(companyId);
  const staff = people.map((p) => ({ ...p, email: p.username.toLowerCase() }));
  const updated: { name: string; matched: string; email: string }[] = [];
  const notFound: string[] = [];
  const invalid: string[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    const { value: email, bad } = cleanAddressList(r.email);
    if (!name) continue;
    if (!email || bad.length) {
      invalid.push(`${name}: ${bad.join(", ") || r.email}`);
      continue;
    }
    const hit = matchPersonByName(staff, name);
    if (!hit) {
      notFound.push(name);
      continue;
    }
    await prisma.employee.update({ where: { id: hit.employeeId }, data: { contactEmail: email } });
    updated.push({ name, matched: hit.name, email });
  }
  return { updated, notFound, invalid };
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** One person's MIS for the day the emails are about. */
export interface PersonData {
  employeeId: string;
  name: string;
  email: string | null;
  hasMis: boolean;
  /** The MIS day ("YYYY-MM-DD") and its label ("Yesterday" / "Last working day"). */
  date: string;
  label: string;
  /** "Mon 5 Oct, 11:00 AM" */
  deadlineText: string;
  /** Live status from the file (warning). */
  status: string;
  blanks: string[];
  note: string | null;
  /** Circle Report cell (result): CM / IN / NC / OL / … */
  code: string | null;
  manual: boolean;
  reason: string | null;
  circles: number;
  pendingCircles: number;
  deductionDays: number;
  untilNext: number;
  circleDates: string[];
  monthLabel: string;
}

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

interface Look {
  label: string;
  color: string;
  bg: string;
}
const RED: Look = { label: "Red circle", color: "#991b1b", bg: "#fee2e2" };
const YELLOW: Look = { label: "Incomplete — yellow", color: "#92400e", bg: "#fef3c7" };
const GREEN: Look = { label: "Submitted — green", color: "#166534", bg: "#dcfce7" };

function monthLines(p: PersonData, extra = 0): string[] {
  const left = p.untilNext;
  const out = [
    p.circles === 0
      ? `No red circles in ${p.monthLabel} so far.`
      : `${deductionCalculation(p.circles)} Salary deduction so far: ${p.deductionDays} day${p.deductionDays === 1 ? "" : "s"}.`,
  ];
  if (p.circleDates.length) out.push(`Red circle dates: ${p.circleDates.join(", ")}`);
  if (extra) {
    const after = p.circles + extra;
    const days = Math.floor(after / CIRCLES_PER_DEDUCTION);
    out.push(
      days > p.deductionDays
        ? `If this day becomes a red circle you will have ${after} — that means ${days} day${days === 1 ? "" : "s"} of salary deducted.`
        : `If this day becomes a red circle you will have ${after} red circle${after === 1 ? "" : "s"} this month.`,
    );
  } else out.push(`${left} more red circle${left === 1 ? "" : "s"} = ${p.deductionDays + 1} day${p.deductionDays + 1 === 1 ? "" : "s"} of salary deducted (every ${CIRCLES_PER_DEDUCTION} red circles in a month = 1 day).`);
  return out;
}

function layout(opts: {
  heading: string;
  first: string;
  intro: string;
  title: string;
  look: Look;
  lines: string[];
  monthTitle: string;
  month: string[];
  monthBad: boolean;
  footer: string | null;
  from: string | null;
}): string {
  const p = (t: string, style = "") => `<div style="font-size:13px;color:#374151;margin-top:6px;${style}">${esc(t)}</div>`;
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:20px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;padding:22px">
        <tr><td style="font-size:18px;font-weight:700;color:#111827;padding-bottom:4px">${esc(opts.heading)}</td></tr>
        <tr><td style="font-size:14px;color:#374151;padding-bottom:16px">Hi ${esc(opts.first)},<br>${esc(opts.intro).replace(/\n/g, "<br>")}</td></tr>
        <tr><td style="padding:0 0 12px 0">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:10px;border-left:5px solid ${opts.look.color}">
            <tr><td style="padding:12px 14px">
              <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">${esc(opts.title)}</div>
              <div style="margin-top:4px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${opts.look.bg};color:${opts.look.color};font-weight:600;font-size:13px">${esc(opts.look.label)}</span></div>
              ${opts.lines.map((l) => p(l)).join("")}
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:4px 0 12px 0">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${opts.monthBad ? "#fef2f2" : "#f0fdf4"};border-radius:10px">
            <tr><td style="padding:12px 14px;font-size:13px;color:#374151">
              <div style="font-weight:600;color:#111827;margin-bottom:2px">${esc(opts.monthTitle)}</div>
              ${opts.month.map((l, i) => p(l, i ? "color:#6b7280" : "")).join("")}
            </td></tr>
          </table>
        </td></tr>
        ${opts.footer ? `<tr><td style="font-size:13px;color:#374151;padding-bottom:12px">${esc(opts.footer).replace(/\n/g, "<br>")}</td></tr>` : ""}
        <tr><td style="font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:10px">
          Automatic email from MailPilot${opts.from ? ` (${esc(opts.from)})` : ""}. Each day's MIS must be filled by ${esc(deadlineClock())} on the next working day. Sundays, the 2nd Saturday and stock market holidays need no MIS.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

const textOf = (first: string, intro: string, title: string, look: Look, lines: string[], monthTitle: string, month: string[], footer: string | null) =>
  [`Hi ${first},`, intro, "", `${title}: ${look.label}`, ...lines.map((l) => `  ${l}`), "", monthTitle, ...month, footer ? `\n${footer}` : ""]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();

/** 9:30 AM: "your MIS for <day> is not submitted — fill it before 11:00 AM". */
export function buildWarningEmail(
  p: PersonData,
  settings: { intro: string | null; footer: string | null },
  from: string | null,
): { subject: string; html: string; text: string } {
  const first = p.name.split(/\s+/)[0] || p.name;
  const vars = { name: p.name, first, date: shortDate(p.date), month: p.monthLabel };
  const incomplete = p.status === "INCOMPLETE";
  const day = shortDate(p.date);
  const subject = incomplete
    ? `Reminder: your MIS for ${day} is incomplete — complete it before ${deadlineClock()}`
    : `Reminder: your MIS for ${day} is not submitted — submit it before ${deadlineClock()}`;
  const intro = settings.intro ? fill(settings.intro, vars) : "This is a reminder from MailPilot about your MIS report.";
  const lines: string[] = [];
  if (incomplete) {
    lines.push(`${p.blanks.length} usual entr${p.blanks.length === 1 ? "y is" : "ies are"} still blank:`);
    lines.push(...p.blanks.slice(0, 15).map((b) => `• ${b}`));
    if (p.blanks.length > 15) lines.push(`• …and ${p.blanks.length - 15} more`);
    lines.push(`Please fill them before ${p.deadlineText}. If they are still blank then, the day is marked incomplete (yellow).`);
  } else {
    lines.push(p.note ?? `Your MIS for ${day} has not been filled yet.`);
    lines.push(`Please submit it before ${p.deadlineText}. If it is not submitted by then, a red circle will be marked.`);
  }
  const look: Look = incomplete ? { ...YELLOW, label: "Incomplete" } : { ...RED, label: "Not submitted" };
  const title = `${p.label} · ${day}`;
  const monthTitle = `${p.monthLabel} — red circles so far: ${p.circles}`;
  const month = monthLines(p, incomplete ? 0 : 1);
  const footer = settings.footer ? fill(settings.footer, vars) : null;
  return {
    subject,
    html: layout({ heading: `MIS reminder — ${day}`, first, intro, title, look, lines, monthTitle, month, monthBad: true, footer, from }),
    text: textOf(first, intro, title, look, lines, monthTitle, month, footer),
  };
}

/** 11:00 AM: red circle marked / yellow / green for <day>. Null = nothing to report (leave, holiday, unreadable file). */
export function buildResultEmail(
  p: PersonData,
  settings: { intro: string | null; footer: string | null },
  from: string | null,
): { subject: string; html: string; text: string; outcome: "RED" | "YELLOW" | "GREEN" } | null {
  const first = p.name.split(/\s+/)[0] || p.name;
  const vars = { name: p.name, first, date: shortDate(p.date), month: p.monthLabel };
  const day = shortDate(p.date);
  let look: Look;
  let outcome: "RED" | "YELLOW" | "GREEN";
  let subject: string;
  const lines: string[] = [];
  if (p.code === "CM") {
    look = RED;
    outcome = "RED";
    subject = `MIS ${day}: not submitted — red circle marked`;
    lines.push(`Your MIS for ${day} was not submitted by ${p.deadlineText}, so a red circle has been marked.`);
    if (p.reason) lines.push(`Why: ${p.reason}`);
    if (p.manual) lines.push("This was marked by HR.");
  } else if (p.code === "IN") {
    look = YELLOW;
    outcome = "YELLOW";
    subject = `MIS ${day}: incomplete — marked yellow (no red circle)`;
    lines.push(`Your MIS for ${day} was submitted, but some usual entries were still blank at ${p.deadlineText}.`);
    if (p.reason) lines.push(p.reason);
    lines.push("It is not a red circle, but please fill every entry you usually fill.");
  } else if (p.code === "NC") {
    look = GREEN;
    outcome = "GREEN";
    subject = `MIS ${day}: submitted — green (no circle)`;
    lines.push(`Thank you — your MIS for ${day} was submitted on time. No circle.`);
  } else return null;
  const intro = settings.intro ? fill(settings.intro, vars) : "Here is the result of your MIS check from MailPilot.";
  const title = `${p.label} · ${day} · checked at ${deadlineClock()}`;
  const monthTitle = `${p.monthLabel} — red circles: ${p.circles}`;
  const month = monthLines(p);
  const footer = settings.footer ? fill(settings.footer, vars) : null;
  return {
    subject,
    outcome,
    html: layout({ heading: `MIS result — ${day}`, first, intro, title, look, lines, monthTitle, month, monthBad: p.circles > 0 || outcome === "RED", footer, from }),
    text: textOf(first, intro, title, look, lines, monthTitle, month, footer),
  };
}

/** One table for HR after the 11:00 AM check. */
export function buildHrSummary(people: PersonData[], from: string | null): { subject: string; html: string; text: string } {
  const day = people[0] ? shortDate(people[0].date) : "";
  const res = (p: PersonData) =>
    p.code === "CM" ? { t: "Red circle", c: "#b91c1c" } : p.code === "IN" ? { t: "Incomplete (yellow)", c: "#b45309" } : p.code === "NC" ? { t: "Submitted (green)", c: "#15803d" } : { t: p.code ?? "—", c: "#6b7280" };
  const red = people.filter((p) => p.code === "CM").length;
  const yellow = people.filter((p) => p.code === "IN").length;
  const green = people.filter((p) => p.code === "NC").length;
  const rows = [...people]
    .sort((a, b) => ["CM", "IN", "NC"].indexOf(a.code ?? "") - ["CM", "IN", "NC"].indexOf(b.code ?? "") || a.name.localeCompare(b.name))
    .map((p) => {
      const r = res(p);
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6">${esc(p.name)}${p.email ? "" : ' <span style="color:#b45309">(no email)</span>'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:${r.c};font-weight:600">${esc(r.t)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:700;color:${p.circles ? "#b91c1c" : "#15803d"}">${p.circles}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:700;color:${p.deductionDays ? "#b91c1c" : "#6b7280"}">${p.deductionDays}</td>
      </tr>`;
    })
    .join("");
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;background:#f6f7f9;margin:0;padding:20px">
    <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;padding:22px">
      <div style="font-size:18px;font-weight:700;color:#111827">MIS result — ${esc(day)} (checked at ${esc(deadlineClock())})</div>
      <div style="font-size:13px;color:#6b7280;margin:4px 0 14px">${red} red circle${red === 1 ? "" : "s"} · ${yellow} incomplete · ${green} submitted · ${people.reduce((n, p) => n + p.deductionDays, 0)} salary day(s) to deduct this month so far.</div>
      <table width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;color:#374151;border-collapse:collapse">
        <tr style="background:#f9fafb;color:#6b7280;font-size:12px;text-align:left">
          <th style="padding:6px 8px">Name</th><th style="padding:6px 8px">${esc(day)}</th><th style="padding:6px 8px">Red circles (month)</th><th style="padding:6px 8px">Salary days</th>
        </tr>
        ${rows}
      </table>
      <div style="font-size:11px;color:#9ca3af;margin-top:14px">Automatic email from MailPilot${from ? ` (${esc(from)})` : ""}. Reasons and evidence: MailPilot → MIS Circle Report → Download Excel.</div>
    </div></body></html>`;
  const text = [`MIS result — ${day}: ${red} red, ${yellow} incomplete, ${green} submitted`, ...people.map((p) => `${p.name}: ${res(p).t} · red circles ${p.circles} · salary days ${p.deductionDays}`)].join("\n");
  return { subject: `MIS result ${day} — ${red} red circle${red === 1 ? "" : "s"}, ${yellow} incomplete, ${green} submitted`, html, text };
}

/** The day the emails are about: the last working day, whose deadline is today at 11:00 AM (if today is a working day). */
async function target(companyId: string, now: Date) {
  const cal = await getWorkCalendar(companyId);
  const f = misFocusDates(now, cal);
  const dl = deadlineFor(f.yesterday, cal);
  return { cal, today: f.today, date: f.yesterday, label: f.labels.last, deadline: dl, deadlineIsToday: dl.day === f.today };
}

/** Everyone's MIS for the target day. `refresh` re-reads the files and records the circle marks first. */
async function collect(companyId: string, now: Date, opts: { employeeId?: string; refresh?: boolean } = {}) {
  const t = await target(companyId, now);
  if (opts.refresh) {
    await Promise.race([runMisChecks(companyId, { employeeId: opts.employeeId }).catch(() => undefined), new Promise((r) => setTimeout(r, 120_000))]);
    await recordAutoMarks(companyId, [t.date], now).catch((e) => console.error("[MIS email] recording marks failed:", e instanceof Error ? e.message : e));
  }
  const [recipients, statuses, month] = await Promise.all([
    listRecipients(companyId),
    getMisStatusForDate(companyId, t.date, opts.employeeId),
    getCircleMonth(companyId, t.date.slice(0, 7), { employeeId: opts.employeeId, now }),
  ]);
  const deadlineText = `${shortDate(t.deadline.day)}, ${deadlineClock()}`;
  const monthLabel = new Date(`${month.month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const people: PersonData[] = [];
  for (const r of recipients) {
    if (opts.employeeId && r.employeeId !== opts.employeeId) continue;
    const row = month.rows.find((x) => x.employeeId === r.employeeId);
    const cell: CircleCell | null = row?.cells[t.date] ?? null;
    const mis = statuses.get(r.employeeId) ?? null;
    const entries = row ? redCircleEntries(row, month.days.map((d) => d.date)).filter((e) => !e.pending) : [];
    people.push({
      employeeId: r.employeeId,
      name: r.name,
      email: r.email,
      hasMis: r.hasMis,
      date: t.date,
      label: t.label,
      deadlineText,
      status: mis?.status ?? "NOT_CHECKED",
      blanks: (mis?.sources ?? []).flatMap((s) => s.blanks.map((b) => `${b.cell} — ${b.field}`)),
      note: mis?.sources.find((s) => s.note)?.note ?? null,
      code: cell?.code ?? null,
      manual: cell?.source === "MANUAL",
      reason: cell?.reason ?? null,
      circles: row?.summary.circles ?? 0,
      pendingCircles: row?.summary.pendingCircles ?? 0,
      deductionDays: row?.summary.deductionDays ?? 0,
      untilNext: row?.summary.untilNextDeduction ?? CIRCLES_PER_DEDUCTION,
      circleDates: entries.map((e) => shortDate(e.date)),
      monthLabel,
    });
  }
  return { people, t };
}

/** Who gets the 9:30 warning: an MIS file, not submitted / incomplete, and not marked leave/holiday by HR. */
export const needsWarning = (p: PersonData) => p.hasMis && (p.status === "MISSING" || p.status === "INCOMPLETE") && !(p.manual && p.code !== "CM");

/** The email one person would get (for the preview). */
export async function previewEmail(companyId: string, kind: EmailKind, employeeId: string | undefined, now = new Date()) {
  const settings = await getEmailSettings(companyId);
  const sender = await senderStatus(companyId);
  const { people } = await collect(companyId, now, { employeeId });
  const p = people.find((x) => x.hasMis) ?? people[0];
  if (!p) throw new MisEmailError(404, "Nobody to preview — add MIS staff first.");
  if (kind === "WARN") {
    const mail = buildWarningEmail(p, settings, sender.from);
    return { kind, employeeId: p.employeeId, name: p.name, to: p.email, wouldSend: needsWarning(p), why: needsWarning(p) ? null : `${p.name}'s MIS for ${shortDate(p.date)} is ${p.status === "COMPLETE" ? "already submitted" : p.status.toLowerCase().replace("_", " ")}, so no warning goes to them — this is what it would look like.`, ...mail };
  }
  const mail = buildResultEmail(p, settings, sender.from) ?? buildResultEmail({ ...p, code: p.status === "COMPLETE" ? "NC" : p.status === "INCOMPLETE" ? "IN" : "CM" }, settings, sender.from)!;
  return { kind, employeeId: p.employeeId, name: p.name, to: p.email, wouldSend: !!buildResultEmail(p, settings, sender.from), why: p.code && ["CM", "IN", "NC"].includes(p.code) ? null : `Not decided yet (${p.code ?? "before 11:00 AM"}) — preview based on the file right now.`, subject: mail.subject, html: mail.html, text: mail.text };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** The most recent occurrence of HH:mm (business time zone), with a 5-minute early tolerance. */
export function scheduledOccurrence(now: Date, sendTime: string, tz: string = getMsiTimezone()): { date: string; minutesSince: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const nowMin = Number(p.find((x) => x.type === "hour")?.value) * 60 + Number(p.find((x) => x.type === "minute")?.value);
  const [h, m] = sendTime.split(":").map(Number);
  const raw = (nowMin - (h * 60 + m) + 1440) % 1440;
  const today = businessDateString(now, tz);
  if (raw > 1440 - 5) {
    // A few minutes early counts as on time (e.g. 23:59 for a midnight run belongs to the coming date).
    const at = nowMin + (1440 - raw);
    return { date: at >= 1440 ? addDaysTo(today, 1) : today, minutesSince: 0 };
  }
  return { date: nowMin - raw < 0 ? addDaysTo(today, -1) : today, minutesSince: raw };
}

export interface RunSummary {
  runId: string;
  kind: EmailKind;
  runDate: string;
  misDate: string | null;
  trigger: EmailTrigger;
  startedAt: string;
  finishedAt: string | null;
  sent: number;
  failed: number;
  skipped: number;
  noEmail: string[];
  outcomes: { red: number; yellow: number; green: number } | null;
  hr: "SENT" | "FAILED" | "OFF" | null;
  note: string | null;
  errors: string[];
}

const runningCompanies = new Set<string>();
const done = (s: RunSummary, note: string): RunSummary => ({ ...s, note, finishedAt: new Date().toISOString() });

/**
 * Sends the warning or the result emails. Scheduled runs (SCHEDULE / CRON)
 * happen once per working day each, claimed atomically, so the backend's own
 * timer and cron-job.org never double-send.
 */
export async function runMisEmails(
  companyId: string,
  opts: { kind: EmailKind; trigger: EmailTrigger; force?: boolean; testTo?: string; employeeId?: string; now?: Date },
): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const settings = await getEmailSettings(companyId);
  const t = await target(companyId, now);
  const summary: RunSummary = {
    runId: crypto.randomUUID(),
    kind: opts.kind,
    runDate: t.today,
    misDate: t.date,
    trigger: opts.trigger,
    startedAt: now.toISOString(),
    finishedAt: null,
    sent: 0,
    failed: 0,
    skipped: 0,
    noEmail: [],
    outcomes: null,
    hr: null,
    note: null,
    errors: [],
  };
  const scheduled = opts.trigger === "SCHEDULE" || opts.trigger === "CRON";
  const lastField = opts.kind === "WARN" ? "lastWarnDate" : "lastResultDate";

  if (scheduled) {
    if (!settings.enabled) return done(summary, "MIS emails are switched off.");
    if (opts.kind === "WARN" && !settings.warnEnabled) return done(summary, "The warning email is switched off.");
    if (opts.kind === "RESULT" && !settings.resultEnabled) return done(summary, "The result email is switched off.");
    if (!t.deadlineIsToday) return done(summary, "Today is a day off — no MIS deadline today.");
    if (opts.kind === "WARN" && now >= t.deadline.at) return done(summary, `Too late for the warning — the ${deadlineClock()} deadline has passed.`);
    if (opts.kind === "RESULT" && now < t.deadline.at) return done(summary, `Too early — the result goes out after the ${deadlineClock()} deadline.`);
  }
  if (runningCompanies.has(companyId)) {
    if (scheduled) return done(summary, "Emails are already being sent.");
    throw new MisEmailError(409, "Emails are already being sent — try again in a minute.");
  }
  if (scheduled) {
    const claim = await prisma.misEmailSettings.updateMany({
      where: { companyId, ...(opts.force ? {} : { OR: [{ [lastField]: null }, { [lastField]: { not: t.today } }] }) },
      data: { [lastField]: t.today, lastRunAt: now },
    });
    if (!claim.count) return done(summary, `Already sent today (${t.today}).`);
  }
  runningCompanies.add(companyId);
  try {
    const sender = await senderStatus(companyId);
    if (!sender.canSend) throw new MisEmailError(409, sender.problem ?? "Email sending isn't set up.");
    const { people } = await collect(companyId, now, { employeeId: opts.employeeId, refresh: opts.trigger !== "TEST" });
    const log = (employeeId: string | null, to: string, subject: string, status: "SENT" | "FAILED" | "SKIPPED", error?: string, kind: string = opts.kind) =>
      prisma.misEmailLog
        .create({ data: { companyId, runId: summary.runId, runDate: t.today, trigger: opts.trigger, kind, employeeId, toEmail: to, subject, status, error: error?.slice(0, 1000) ?? null } })
        .catch(() => undefined);

    if (opts.trigger === "TEST") {
      const to = opts.testTo?.trim().toLowerCase();
      if (!to || !isEmail(to)) throw new MisEmailError(400, "Enter the email address to send the test to.");
      const p = people.find((x) => x.hasMis) ?? people[0];
      if (!p) throw new MisEmailError(404, "Nobody to build a test email for — add MIS staff first.");
      const mail =
        opts.kind === "WARN"
          ? buildWarningEmail({ ...p, status: p.status === "INCOMPLETE" ? "INCOMPLETE" : "MISSING" }, settings, sender.from)
          : buildResultEmail(p, settings, sender.from) ?? buildResultEmail({ ...p, code: p.status === "COMPLETE" ? "NC" : p.status === "INCOMPLETE" ? "IN" : "CM" }, settings, sender.from)!;
      try {
        await deliver(companyId, { to: [to], subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
        summary.sent++;
        await log(p.employeeId, to, `[TEST] ${mail.subject}`, "SENT");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await log(p.employeeId, to, `[TEST] ${mail.subject}`, "FAILED", msg);
        throw e instanceof MisEmailError || e instanceof MisGraphError ? e : new MisEmailError(502, msg);
      }
      return done(summary, `Test ${opts.kind === "WARN" ? "warning" : "result"} email (for ${p.name}) sent to ${to}.`);
    }

    let first = true;
    const send = async (p: PersonData, mail: { subject: string; html: string; text: string }) => {
      if (!first) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
      first = false;
      try {
        await deliver(companyId, { to: parseEmailList(p.email), subject: mail.subject, html: mail.html, text: mail.text });
        summary.sent++;
        await log(p.employeeId, p.email!, mail.subject, "SENT");
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.failed++;
        summary.errors.push(`${p.name}: ${msg}`);
        await log(p.employeeId, p.email!, mail.subject, "FAILED", msg);
        return !(e instanceof MisGraphError && e.reconnect); // stop: every other email would fail the same way
      }
    };

    if (opts.kind === "WARN") {
      for (const p of people) {
        if (!needsWarning(p)) continue;
        if (!p.email) {
          summary.noEmail.push(p.name);
          summary.skipped++;
          continue;
        }
        if (!(await send(p, buildWarningEmail(p, settings, sender.from)))) break;
      }
      if (!summary.sent && !summary.failed && !summary.noEmail.length) summary.note = "Everyone has submitted — no warnings needed.";
    } else {
      summary.outcomes = { red: 0, yellow: 0, green: 0 };
      for (const p of people) {
        if (!p.hasMis) continue;
        const mail = buildResultEmail(p, settings, sender.from);
        if (!mail) {
          summary.skipped++;
          continue;
        }
        summary.outcomes[mail.outcome === "RED" ? "red" : mail.outcome === "YELLOW" ? "yellow" : "green"]++;
        if (!p.email) {
          summary.noEmail.push(p.name);
          summary.skipped++;
          continue;
        }
        if (settings.audience === "ISSUES" && mail.outcome === "GREEN") {
          summary.skipped++;
          continue;
        }
        if (!(await send(p, mail))) break;
      }
      const hrList = parseEmailList(settings.hrEmails);
      const reportable = people.filter((p) => p.hasMis && ["CM", "IN", "NC"].includes(p.code ?? ""));
      if (!opts.employeeId && settings.hrSummary && hrList.length && reportable.length) {
        const hr = buildHrSummary(reportable, sender.from);
        await new Promise((r) => setTimeout(r, first ? 0 : SEND_GAP_MS));
        try {
          await deliver(companyId, { to: hrList, subject: hr.subject, html: hr.html, text: hr.text });
          summary.hr = "SENT";
          await log(null, hrList.join(", "), hr.subject, "SENT", undefined, "SUMMARY");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          summary.hr = "FAILED";
          summary.errors.push(`HR summary: ${msg}`);
          await log(null, hrList.join(", "), hr.subject, "FAILED", msg, "SUMMARY");
        }
      } else summary.hr = "OFF";
    }

    summary.finishedAt = new Date().toISOString();
    await prisma.misEmailSettings.update({ where: { companyId }, data: { lastRunAt: now, lastRunSummary: summary as unknown as Prisma.InputJsonValue } });
    return summary;
  } catch (e) {
    // A scheduled run that couldn't start gives the day back, so the next attempt can try again.
    if (scheduled) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.misEmailSettings
        .update({ where: { companyId }, data: { [lastField]: null, lastRunSummary: { ...summary, note: `Not sent: ${msg}`, finishedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue } })
        .catch(() => undefined);
    }
    throw e;
  } finally {
    runningCompanies.delete(companyId);
  }
}

/** Which email is due right now, if any. */
export function dueKind(
  s: { warnEnabled: boolean; warnTime: string; resultEnabled: boolean; lastWarnDate: string | null; lastResultDate: string | null },
  t: { today: string; deadlineIsToday: boolean; deadline: { at: Date } },
  now: Date,
): EmailKind | null {
  if (!t.deadlineIsToday) return null;
  const warn = scheduledOccurrence(now, s.warnTime);
  if (s.warnEnabled && s.lastWarnDate !== t.today && warn.date === t.today && warn.minutesSince < WARN_WINDOW_MIN && now < t.deadline.at) return "WARN";
  const since = (now.getTime() - t.deadline.at.getTime()) / 60_000;
  if (s.resultEnabled && s.lastResultDate !== t.today && since >= 0 && since < RESULT_WINDOW_MIN) return "RESULT";
  return null;
}

/** Called every 5 minutes by the backend's scheduler. */
export async function runDueMisEmails(now = new Date()) {
  const all = await prisma.misEmailSettings.findMany({ where: { enabled: true } });
  for (const s of all) {
    const t = await target(s.companyId, now);
    const kind = dueKind(s, t, now);
    if (!kind) continue;
    await runMisEmails(s.companyId, { kind, trigger: "SCHEDULE", now }).catch((e) => console.error(`[MIS email] scheduled ${kind} failed:`, e instanceof Error ? e.message : e));
  }
}

/** The outside timer's call (cron-job.org). Returns at once; the emails go out in the background. */
export async function triggerFromCron(token: string, opts: { type?: string; force?: boolean } = {}) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new MisEmailError(404, "Unknown link.");
  const s = await prisma.misEmailSettings.findUnique({ where: { cronToken: token } });
  if (!s) throw new MisEmailError(404, "Unknown link.");
  if (!s.enabled) return { accepted: false, note: "MIS emails are switched off in MailPilot." };
  const now = new Date();
  const t = await target(s.companyId, now);
  const kind: EmailKind | null =
    opts.type === "warn" ? "WARN" : opts.type === "result" ? "RESULT" : now < t.deadline.at ? "WARN" : "RESULT";
  if (!t.deadlineIsToday) return { accepted: false, note: "Today is a day off — no MIS deadline today." };
  if (!opts.force && (kind === "WARN" ? s.lastWarnDate : s.lastResultDate) === t.today) return { accepted: false, note: `Already sent today.` };
  void runMisEmails(s.companyId, { kind, trigger: "CRON", force: opts.force, now }).catch((e) => console.error(`[MIS email] cron ${kind} failed:`, e instanceof Error ? e.message : e));
  return { accepted: true, note: `Sending the ${kind === "WARN" ? "warning" : "result"} emails for ${shortDate(t.date)}.` };
}

/** Last runs for the admin page, newest first. */
export async function recentEmailLog(companyId: string, limit = 200) {
  const rows = await prisma.misEmailLog.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 500) });
  const names = new Map(
    (await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId).filter((x): x is string => !!x))] } }, select: { id: true, firstName: true, lastName: true } })).map(
      (e) => [e.id, `${e.firstName} ${e.lastName}`.trim()],
    ),
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), name: r.employeeId ? names.get(r.employeeId) ?? null : "HR summary" }));
}
