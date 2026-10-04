/**
 * Nightly MIS email — one email per MIS staff member at a set time, plus an
 * optional summary for HR.
 *
 * Each person gets:
 *   - their last working day's MIS: submitted / incomplete (which cells) /
 *     not filled, and the deadline to fix it (end of the next working day);
 *   - the working day before it, now locked: red circle or not, and why;
 *   - this month's red circles, salary deduction and how many more circles
 *     until the next deducted day.
 *
 * Sending is free:
 *   - "graph" (default): Microsoft Graph sendMail from the Microsoft 365
 *     account MailPilot already uses for the MIS files (contactus@…). Needs the
 *     Mail.Send permission — reconnect the account once. A copy of every email
 *     stays in that mailbox's Sent Items.
 *   - "brevo": Brevo's free HTTP API (300 emails/day), MIS_EMAIL_DRIVER=brevo,
 *     BREVO_API_KEY, MIS_EMAIL_FROM.
 *   - "console": only writes to the server log (testing).
 * Render's free plan blocks SMTP ports, so plain SMTP is not an option there.
 *
 * Triggers (both safe together — a day is only ever sent once):
 *   - the backend's own scheduler, within 30 minutes after the send time;
 *   - an outside scheduler (cron-job.org) calling /api/mis/email/cron/<token>
 *     at the send time — also wakes the server if it was asleep.
 */
import crypto from "node:crypto";
import { prisma } from "../lib/db";
import { Prisma } from "../generated/prisma/client";
import { MisGraphError, getMisAccessToken, scopesAllowMail, sendGraphMail } from "./misMicrosoft";
import { getMisStatusForDate, matchExistingStaff, misFocusDates, runMisChecks, type MisEmployeeDay } from "./misService";
import { CIRCLES_PER_DEDUCTION, deductionCalculation, getCircleMonth, redCircleEntries, type CircleMonth } from "./misCircle";
import { deadlineFor, fmtWhen } from "./misEvidence";
import { businessDateString, getMsiTimezone } from "./msiService";
import { addDaysTo, getWorkCalendar, offDay, shortDate } from "./workCalendar";

export class MisEmailError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type EmailTrigger = "SCHEDULE" | "CRON" | "MANUAL" | "TEST";

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s.trim());
const SEND_GAP_MS = Number(process.env.MIS_EMAIL_GAP_MS ?? 2500); // Exchange allows 30 messages a minute
const AUTO_WINDOW_MIN = 30;

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
  sendTime?: string;
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
  if (input.sendTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.sendTime)) throw new MisEmailError(400, "Send time must be HH:mm, e.g. 23:30.");
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
      sendTime: input.sendTime,
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

export async function setRecipientEmail(companyId: string, employeeId: string, email: string | null) {
  const value = email?.trim().toLowerCase() || null;
  if (value && !isEmail(value)) throw new MisEmailError(400, "That doesn't look like an email address.");
  const { count } = await prisma.employee.updateMany({ where: { id: employeeId, companyId }, data: { contactEmail: value } });
  if (!count) throw new MisEmailError(404, "Person not found.");
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
    const email = r.email.trim().toLowerCase();
    if (!name) continue;
    if (!isEmail(email)) {
      invalid.push(`${name}: ${r.email}`);
      continue;
    }
    const lower = name.toLowerCase();
    const hit =
      matchExistingStaff(staff, name) ??
      staff.find((p) => p.name.toLowerCase() === lower) ??
      (() => {
        const first = staff.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === lower.split(/\s+/)[0]);
        return first.length === 1 ? first[0] : null;
      })();
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

interface DayInfo {
  date: string;
  label: string;
  /** Still open (before its deadline). */
  open: boolean;
  deadlineText: string;
  mis: MisEmployeeDay | null;
  /** Circle Report code for the day (after the deadline). */
  code: string | null;
  reason: string | null;
}

interface PersonData {
  employeeId: string;
  name: string;
  email: string | null;
  hasMis: boolean;
  days: DayInfo[];
  circles: number;
  pendingCircles: number;
  deductionDays: number;
  untilNext: number;
  circleDates: string[];
  monthLabel: string;
}

const STATUS_COPY: Record<string, { label: string; color: string; bg: string }> = {
  COMPLETE: { label: "Submitted", color: "#166534", bg: "#dcfce7" },
  INCOMPLETE: { label: "Incomplete", color: "#92400e", bg: "#fef3c7" },
  MISSING: { label: "Not submitted", color: "#991b1b", bg: "#fee2e2" },
  ERROR: { label: "Couldn't read the file", color: "#374151", bg: "#f3f4f6" },
  OFF: { label: "Day off", color: "#374151", bg: "#f3f4f6" },
  NOT_CHECKED: { label: "Not checked yet", color: "#374151", bg: "#f3f4f6" },
};

/** What a day looks like in the email: open days show the live status, closed days the locked circle code. */
function dayView(d: DayInfo): { label: string; color: string; bg: string; lines: string[]; issue: boolean } {
  const status = d.mis?.status ?? "NOT_CHECKED";
  const lines: string[] = [];
  const blanks = (d.mis?.sources ?? []).flatMap((s) => s.blanks.map((b) => `${b.cell} — ${b.field}`));
  const note = d.mis?.sources.find((s) => s.note)?.note ?? null;
  if (d.open) {
    const st = STATUS_COPY[status] ?? STATUS_COPY.NOT_CHECKED;
    if (status === "INCOMPLETE") {
      lines.push(`${blanks.length} usual entr${blanks.length === 1 ? "y is" : "ies are"} blank:`);
      lines.push(...blanks.slice(0, 12).map((b) => `• ${b}`));
      if (blanks.length > 12) lines.push(`• …and ${blanks.length - 12} more`);
    } else if (status === "MISSING") {
      lines.push(note ?? "Nothing filled for this day yet.");
    } else if (status === "ERROR") {
      lines.push("MailPilot couldn't open your MIS file — please tell your admin.");
    }
    if (status !== "COMPLETE") lines.push(`Deadline: ${d.deadlineText}. Fill it before then, or it becomes a red circle.`);
    else lines.push("Thank you — nothing to do.");
    return { ...st, lines, issue: status !== "COMPLETE" };
  }
  // Closed: the Circle Report code is final.
  if (d.code === "CM") {
    lines.push(d.reason ?? note ?? "Not filled by the deadline.");
    lines.push("This day is a red circle.");
    return { label: "Red circle", color: "#991b1b", bg: "#fee2e2", lines, issue: true };
  }
  if (d.code === "IN") {
    lines.push(d.reason ?? "Filled, with a few usual entries blank.");
    lines.push("Not a red circle, but please fill every usual entry.");
    return { label: "Incomplete", color: "#92400e", bg: "#fef3c7", lines, issue: true };
  }
  if (d.code === "NC") return { label: "Submitted", color: "#166534", bg: "#dcfce7", lines: ["Submitted on time."], issue: false };
  if (d.code) return { label: d.code, color: "#374151", bg: "#f3f4f6", lines: [d.reason ?? ""].filter(Boolean), issue: false };
  const st = STATUS_COPY[status] ?? STATUS_COPY.NOT_CHECKED;
  return { ...st, lines: note ? [note] : [], issue: status !== "COMPLETE" && status !== "OFF" };
}

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

export function buildPersonEmail(
  p: PersonData,
  settings: { subject: string | null; intro: string | null; footer: string | null },
  from: string | null,
  today: string,
): { subject: string; html: string; text: string; hasIssue: boolean } {
  const first = p.name.split(/\s+/)[0] || p.name;
  const vars = { name: p.name, first, date: shortDate(today), month: p.monthLabel };
  const views = p.days.map((d) => ({ d, v: dayView(d) }));
  const hasIssue = views.some((x) => x.v.issue) || p.pendingCircles > 0;
  const subject = fill(settings.subject || "MIS update — {name} — {date}", vars);
  const intro = settings.intro ? fill(settings.intro, vars) : "Here is your MIS status from MailPilot.";
  const left = p.untilNext;
  const monthLine =
    p.circles === 0
      ? `No red circles in ${p.monthLabel} so far.`
      : `${deductionCalculation(p.circles)} Salary deduction so far: ${p.deductionDays} day${p.deductionDays === 1 ? "" : "s"}.`;
  const nextLine = `${left} more red circle${left === 1 ? "" : "s"} = ${p.deductionDays + 1} day${p.deductionDays + 1 === 1 ? "" : "s"} of salary deducted (every ${CIRCLES_PER_DEDUCTION} red circles in a month = 1 day).`;

  const card = (title: string, v: ReturnType<typeof dayView>) => `
    <tr><td style="padding:0 0 12px 0">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:10px;border-left:5px solid ${v.color}">
        <tr><td style="padding:12px 14px">
          <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">${esc(title)}</div>
          <div style="margin-top:4px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${v.bg};color:${v.color};font-weight:600;font-size:13px">${esc(v.label)}</span></div>
          ${v.lines.map((l) => `<div style="font-size:13px;color:#374151;margin-top:6px">${esc(l)}</div>`).join("")}
        </td></tr>
      </table>
    </td></tr>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:20px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;padding:22px">
        <tr><td style="font-size:18px;font-weight:700;color:#111827;padding-bottom:4px">MIS update — ${esc(vars.date)}</td></tr>
        <tr><td style="font-size:14px;color:#374151;padding-bottom:16px">Hi ${esc(first)},<br>${esc(intro).replace(/\n/g, "<br>")}</td></tr>
        ${p.hasMis ? views.map(({ d, v }) => card(`${d.label} · ${shortDate(d.date)}${d.open ? "" : " · closed"}`, v)).join("") : `<tr><td style="font-size:13px;color:#6b7280;padding-bottom:12px">No MIS file is linked to your name in MailPilot yet — please tell HR.</td></tr>`}
        <tr><td style="padding:4px 0 12px 0">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${p.circles ? "#fef2f2" : "#f0fdf4"};border-radius:10px">
            <tr><td style="padding:12px 14px;font-size:13px;color:#374151">
              <div style="font-weight:600;color:#111827;margin-bottom:4px">${esc(p.monthLabel)} — red circles: ${p.circles}${p.pendingCircles ? ` (+${p.pendingCircles} pending)` : ""}</div>
              <div>${esc(monthLine)}</div>
              ${p.circleDates.length ? `<div style="margin-top:4px">Red circle dates: ${esc(p.circleDates.join(", "))}</div>` : ""}
              <div style="margin-top:4px;color:#6b7280">${esc(nextLine)}</div>
            </td></tr>
          </table>
        </td></tr>
        ${settings.footer ? `<tr><td style="font-size:13px;color:#374151;padding-bottom:12px">${esc(fill(settings.footer, vars)).replace(/\n/g, "<br>")}</td></tr>` : ""}
        <tr><td style="font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:10px">
          Automatic email from MailPilot${from ? ` (${esc(from)})` : ""}. MIS is checked every 10 minutes; you have until the end of the next working day to fill a day. Sundays, the 2nd Saturday and stock market holidays need no MIS.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  const text = [
    `Hi ${first},`,
    intro,
    "",
    ...(p.hasMis
      ? views.flatMap(({ d, v }) => [`${d.label} (${shortDate(d.date)})${d.open ? "" : " — closed"}: ${v.label}`, ...v.lines.map((l) => `  ${l}`), ""])
      : ["No MIS file is linked to your name in MailPilot yet — please tell HR.", ""]),
    `${p.monthLabel} — red circles: ${p.circles}${p.pendingCircles ? ` (+${p.pendingCircles} pending)` : ""}`,
    monthLine,
    p.circleDates.length ? `Red circle dates: ${p.circleDates.join(", ")}` : "",
    nextLine,
    settings.footer ? `\n${fill(settings.footer, vars)}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return { subject, html, text, hasIssue };
}

export function buildHrSummary(people: PersonData[], today: string, from: string | null): { subject: string; html: string; text: string } {
  const head = people[0]?.days ?? [];
  const cell = (d: DayInfo | undefined) => {
    if (!d) return { label: "—", color: "#6b7280" };
    const v = dayView(d);
    return { label: v.label, color: v.color };
  };
  const rows = people
    .map((p) => {
      const a = cell(p.days[0]);
      const b = cell(p.days[1]);
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6">${esc(p.name)}${p.email ? "" : ' <span style="color:#b45309">(no email)</span>'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:${a.color};font-weight:600">${esc(a.label)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:${b.color};font-weight:600">${esc(b.label)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:700;color:${p.circles ? "#b91c1c" : "#15803d"}">${p.circles}${p.pendingCircles ? ` (+${p.pendingCircles})` : ""}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;text-align:center;font-weight:700;color:${p.deductionDays ? "#b91c1c" : "#6b7280"}">${p.deductionDays}</td>
      </tr>`;
    })
    .join("");
  const red = people.filter((p) => p.days[1] && dayView(p.days[1]).label === "Red circle").length;
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;background:#f6f7f9;margin:0;padding:20px">
    <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:12px;padding:22px">
      <div style="font-size:18px;font-weight:700;color:#111827">MIS summary — ${esc(shortDate(today))}</div>
      <div style="font-size:13px;color:#6b7280;margin:4px 0 14px">${people.length} staff · ${red} new red circle${red === 1 ? "" : "s"} · ${people.reduce((n, p) => n + p.deductionDays, 0)} salary day(s) to deduct this month so far.</div>
      <table width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;color:#374151;border-collapse:collapse">
        <tr style="background:#f9fafb;color:#6b7280;font-size:12px;text-align:left">
          <th style="padding:6px 8px">Name</th>
          <th style="padding:6px 8px">${esc(head[0] ? `${head[0].label} (${shortDate(head[0].date)})` : "Last working day")}</th>
          <th style="padding:6px 8px">${esc(head[1] ? `${head[1].label} (${shortDate(head[1].date)})` : "Previous")}</th>
          <th style="padding:6px 8px">Red circles (month)</th>
          <th style="padding:6px 8px">Salary days</th>
        </tr>
        ${rows}
      </table>
      <div style="font-size:11px;color:#9ca3af;margin-top:14px">Automatic email from MailPilot${from ? ` (${esc(from)})` : ""}. Full details and evidence: MailPilot → MIS Circle Report → Download Excel.</div>
    </div></body></html>`;
  const text = [
    `MIS summary — ${shortDate(today)}`,
    ...people.map((p) => `${p.name}: ${cell(p.days[0]).label} / ${cell(p.days[1]).label} · red circles ${p.circles} · salary days ${p.deductionDays}`),
  ].join("\n");
  return { subject: `MIS summary — ${shortDate(today)} — ${red} new red circle${red === 1 ? "" : "s"}`, html, text };
}

/** Everything the emails need, for everyone (or one person). Re-reads stale MIS files first. */
async function collect(companyId: string, now: Date, opts: { employeeId?: string; refresh?: boolean } = {}): Promise<{ people: PersonData[]; today: string }> {
  if (opts.refresh) {
    await Promise.race([runMisChecks(companyId, { employeeId: opts.employeeId }).catch(() => undefined), new Promise((r) => setTimeout(r, 120_000))]);
  }
  const cal = await getWorkCalendar(companyId);
  const f = misFocusDates(now, cal);
  const [recipients, lastDay, prevDay] = await Promise.all([
    listRecipients(companyId),
    getMisStatusForDate(companyId, f.yesterday, opts.employeeId),
    getMisStatusForDate(companyId, f.dayBefore, opts.employeeId),
  ]);
  const months = [...new Set([f.yesterday.slice(0, 7), f.dayBefore.slice(0, 7)])];
  const monthData = new Map<string, CircleMonth>();
  for (const m of months) monthData.set(m, await getCircleMonth(companyId, m, { employeeId: opts.employeeId, now }));
  const current = monthData.get(f.yesterday.slice(0, 7))!;
  const rowOf = (month: string, id: string) => monthData.get(month)?.rows.find((r) => r.employeeId === id);

  const people: PersonData[] = [];
  for (const r of recipients) {
    if (opts.employeeId && r.employeeId !== opts.employeeId) continue;
    const row = rowOf(current.month, r.employeeId);
    const days: DayInfo[] = [
      { date: f.yesterday, label: f.labels.last, mis: lastDay.get(r.employeeId) ?? null },
      { date: f.dayBefore, label: f.labels.previous, mis: prevDay.get(r.employeeId) ?? null },
    ].map((d) => {
      const dl = deadlineFor(d.date, cal);
      const cell = rowOf(d.date.slice(0, 7), r.employeeId)?.cells[d.date] ?? null;
      return {
        ...d,
        open: now < dl.at,
        deadlineText: `${shortDate(dl.day)}, ${fmtWhen(new Date(dl.at.getTime() - 60_000)).slice(11)}`,
        code: cell?.code ?? null,
        reason: cell?.reason ?? null,
      };
    });
    const entries = row ? redCircleEntries(row, current.days.map((d) => d.date)).filter((e) => !e.pending) : [];
    people.push({
      employeeId: r.employeeId,
      name: r.name,
      email: r.email,
      hasMis: r.hasMis,
      days,
      circles: row?.summary.circles ?? 0,
      pendingCircles: row?.summary.pendingCircles ?? 0,
      deductionDays: row?.summary.deductionDays ?? 0,
      untilNext: row?.summary.untilNextDeduction ?? CIRCLES_PER_DEDUCTION,
      circleDates: entries.map((e) => shortDate(e.date)),
      monthLabel: new Date(`${current.month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    });
  }
  return { people, today: f.today };
}

/** The email one person would get right now (for the preview). */
export async function previewEmail(companyId: string, employeeId: string | undefined, now = new Date()) {
  const settings = await getEmailSettings(companyId);
  const sender = await senderStatus(companyId);
  const { people, today } = await collect(companyId, now, { employeeId });
  const p = people[0];
  if (!p) throw new MisEmailError(404, "Nobody to preview — add MIS staff first.");
  const mail = buildPersonEmail(p, settings, sender.from, today);
  return { employeeId: p.employeeId, name: p.name, to: p.email, ...mail };
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
  runDate: string;
  trigger: EmailTrigger;
  startedAt: string;
  finishedAt: string | null;
  sent: number;
  failed: number;
  skipped: number;
  noEmail: string[];
  hr: "SENT" | "FAILED" | "OFF" | null;
  note: string | null;
  errors: string[];
}

const runningCompanies = new Set<string>();

/**
 * Sends the emails. SCHEDULE / CRON runs happen once per day (claimed
 * atomically, so the backend's own timer and cron-job.org never double-send).
 */
export async function runMisEmails(
  companyId: string,
  opts: { trigger: EmailTrigger; force?: boolean; testTo?: string; employeeId?: string; now?: Date } = { trigger: "MANUAL" },
): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const settings = await getEmailSettings(companyId);
  const occ = scheduledOccurrence(now, settings.sendTime);
  const runDate = opts.trigger === "SCHEDULE" || opts.trigger === "CRON" ? occ.date : businessDateString(now);
  const summary: RunSummary = {
    runId: crypto.randomUUID(),
    runDate,
    trigger: opts.trigger,
    startedAt: now.toISOString(),
    finishedAt: null,
    sent: 0,
    failed: 0,
    skipped: 0,
    noEmail: [],
    hr: null,
    note: null,
    errors: [],
  };
  const scheduled = opts.trigger === "SCHEDULE" || opts.trigger === "CRON";
  if (runningCompanies.has(companyId)) {
    if (scheduled) return { ...summary, note: "Emails are already being sent.", finishedAt: new Date().toISOString() };
    throw new MisEmailError(409, "Emails are already being sent — try again in a minute.");
  }

  if (scheduled) {
    if (!settings.enabled) return { ...summary, note: "Nightly email is switched off.", finishedAt: new Date().toISOString() };
    // The evening this run belongs to: a run soon after midnight is for the day that just ended.
    const [h] = settings.sendTime.split(":").map(Number);
    const evening = h < 6 ? addDaysTo(runDate, -1) : runDate;
    const off = offDay(evening, await getWorkCalendar(companyId));
    if (settings.skipOffDays && off) {
      await prisma.misEmailSettings.update({ where: { companyId }, data: { lastRunDate: runDate, lastRunAt: now, lastRunSummary: { ...summary, note: `Skipped — ${off.name} (day off).`, finishedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue } });
      return { ...summary, note: `Skipped — ${off.name} (day off).` };
    }
    // Claim the day: only one run per day, whoever comes first.
    const claim = await prisma.misEmailSettings.updateMany({
      where: { companyId, ...(opts.force ? {} : { OR: [{ lastRunDate: null }, { lastRunDate: { not: runDate } }] }) },
      data: { lastRunDate: runDate, lastRunAt: now },
    });
    if (!claim.count) return { ...summary, note: `Already sent for ${runDate}.`, finishedAt: new Date().toISOString() };
  }
  runningCompanies.add(companyId);
  try {
    const sender = await senderStatus(companyId);
    if (!sender.canSend) throw new MisEmailError(409, sender.problem ?? "Email sending isn't set up.");
    const { people, today } = await collect(companyId, now, { employeeId: opts.employeeId, refresh: opts.trigger !== "TEST" });
    const log = (employeeId: string | null, to: string, subject: string, status: "SENT" | "FAILED" | "SKIPPED", error?: string) =>
      prisma.misEmailLog
        .create({ data: { companyId, runId: summary.runId, runDate, trigger: opts.trigger, employeeId, toEmail: to, subject, status, error: error?.slice(0, 1000) ?? null } })
        .catch(() => undefined);

    if (opts.trigger === "TEST") {
      const to = opts.testTo?.trim().toLowerCase();
      if (!to || !isEmail(to)) throw new MisEmailError(400, "Enter the email address to send the test to.");
      const p = people[0];
      if (!p) throw new MisEmailError(404, "Nobody to build a test email for — add MIS staff first.");
      const mail = buildPersonEmail(p, settings, sender.from, today);
      try {
        await deliver(companyId, { to: [to], subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
        summary.sent++;
        await log(p.employeeId, to, `[TEST] ${mail.subject}`, "SENT");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.failed++;
        summary.errors.push(msg);
        await log(p.employeeId, to, `[TEST] ${mail.subject}`, "FAILED", msg);
        throw e instanceof MisEmailError || e instanceof MisGraphError ? e : new MisEmailError(502, msg);
      }
      return { ...summary, finishedAt: new Date().toISOString(), note: `Test email for ${p.name} sent to ${to}.` };
    }

    let first = true;
    for (const p of people) {
      const mail = buildPersonEmail(p, settings, sender.from, today);
      if (!p.email) {
        summary.noEmail.push(p.name);
        summary.skipped++;
        continue;
      }
      if (settings.audience === "ISSUES" && !mail.hasIssue) {
        summary.skipped++;
        await log(p.employeeId, p.email, mail.subject, "SKIPPED", "Nothing pending (audience: only people with something to fix).");
        continue;
      }
      if (!first) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
      first = false;
      try {
        await deliver(companyId, { to: [p.email], subject: mail.subject, html: mail.html, text: mail.text });
        summary.sent++;
        await log(p.employeeId, p.email, mail.subject, "SENT");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.failed++;
        summary.errors.push(`${p.name}: ${msg}`);
        await log(p.employeeId, p.email, mail.subject, "FAILED", msg);
        if (e instanceof MisGraphError && e.reconnect) break; // every other email would fail the same way
      }
    }

    const hrList = parseEmailList(settings.hrEmails);
    if (!opts.employeeId && settings.hrSummary && hrList.length && people.length) {
      const hr = buildHrSummary(people, today, sender.from);
      await new Promise((r) => setTimeout(r, first ? 0 : SEND_GAP_MS));
      try {
        await deliver(companyId, { to: hrList, subject: hr.subject, html: hr.html, text: hr.text });
        summary.hr = "SENT";
        await log(null, hrList.join(", "), hr.subject, "SENT");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.hr = "FAILED";
        summary.errors.push(`HR summary: ${msg}`);
        await log(null, hrList.join(", "), hr.subject, "FAILED", msg);
      }
    } else summary.hr = "OFF";

    summary.finishedAt = new Date().toISOString();
    if (scheduled || opts.trigger === "MANUAL")
      await prisma.misEmailSettings.update({ where: { companyId }, data: { lastRunAt: now, lastRunSummary: summary as unknown as Prisma.InputJsonValue } });
    return summary;
  } catch (e) {
    // A scheduled run that couldn't start gives the day back, so the next attempt can try again.
    if (scheduled) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.misEmailSettings
        .update({ where: { companyId }, data: { lastRunDate: null, lastRunSummary: { ...summary, note: `Not sent: ${msg}`, finishedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue } })
        .catch(() => undefined);
    }
    throw e;
  } finally {
    runningCompanies.delete(companyId);
  }
}

/** Called every few minutes by the backend's scheduler: sends within 30 minutes after the send time. */
export async function runDueMisEmails(now = new Date()) {
  const due = await prisma.misEmailSettings.findMany({ where: { enabled: true } });
  for (const s of due) {
    const occ = scheduledOccurrence(now, s.sendTime);
    if (occ.minutesSince >= AUTO_WINDOW_MIN || s.lastRunDate === occ.date) continue;
    await runMisEmails(s.companyId, { trigger: "SCHEDULE", now }).catch((e) => console.error("[MIS email] scheduled run failed:", e instanceof Error ? e.message : e));
  }
}

/** The outside scheduler's call. Returns at once; the emails go out in the background. */
export async function triggerFromCron(token: string, opts: { force?: boolean } = {}) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new MisEmailError(404, "Unknown link.");
  const s = await prisma.misEmailSettings.findUnique({ where: { cronToken: token } });
  if (!s) throw new MisEmailError(404, "Unknown link.");
  if (!s.enabled) return { accepted: false, note: "Nightly email is switched off in MailPilot." };
  const occ = scheduledOccurrence(new Date(), s.sendTime);
  if (!opts.force && s.lastRunDate === occ.date) return { accepted: false, note: `Already sent for ${occ.date}.` };
  void runMisEmails(s.companyId, { trigger: "CRON", force: opts.force }).catch((e) => console.error("[MIS email] cron run failed:", e instanceof Error ? e.message : e));
  return { accepted: true, note: `Sending the MIS emails for ${occ.date}.` };
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
