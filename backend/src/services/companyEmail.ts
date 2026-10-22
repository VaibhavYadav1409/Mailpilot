/**
 * Custom emails to everyone in the company — written in MailPilot and sent
 * now or at a chosen date and time (IST).
 *
 * Who gets it: everyone who isn't suspended and has an email address (their
 * MIS email address if set, else their login email), or only MIS staff, only
 * mailbox users, or people picked by hand. Each person gets their own copy
 * (no one sees the others' addresses), sent from the same account as the MIS
 * emails (contactus@ via Microsoft 365). Every copy is logged (MisEmailLog,
 * kind CUSTOM). {first} and {name} in the subject or message are replaced
 * with the person's first / full name.
 *
 * Scheduled emails are picked up every minute by the scheduler. A send that
 * was interrupted (server restart) resumes without sending anyone a second copy.
 */
import { prisma } from "../lib/db";
import { deliver, esc, isEmail, MisEmailError, parseEmailList, senderStatus } from "./misEmail";
import { businessDateString } from "./msiService";

export type Audience = "ALL" | "MIS" | "MAILBOX" | "CHOSEN";
const AUDIENCES: Audience[] = ["ALL", "MIS", "MAILBOX", "CHOSEN"];
const GAP_MS = Number(process.env.MIS_EMAIL_GAP_MS ?? 2500);
const STUCK_MS = 15 * 60_000;

export interface Person {
  employeeId: string;
  name: string;
  first: string;
  emails: string[];
  group: "MIS" | "MAILBOX";
}

/** Everyone who can get a company email (not suspended, has an address). */
export async function companyPeople(companyId: string): Promise<{ people: Person[]; noEmail: string[] }> {
  const rows = await prisma.employee.findMany({
    where: { companyId, status: { not: "SUSPENDED" } },
    select: { id: true, firstName: true, lastName: true, email: true, contactEmail: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  const people: Person[] = [];
  const noEmail: string[] = [];
  for (const r of rows) {
    const name = `${r.firstName} ${r.lastName}`.trim();
    const login = r.email.includes("@") ? r.email.toLowerCase() : null;
    const emails = [...new Set([...parseEmailList(r.contactEmail).filter(isEmail), ...(login && !r.contactEmail ? [login] : [])])];
    if (!emails.length) {
      noEmail.push(name);
      continue;
    }
    people.push({ employeeId: r.id, name, first: name.split(/\s+/)[0] || name, emails, group: login ? "MAILBOX" : "MIS" });
  }
  return { people, noEmail };
}

export function pick(people: Person[], audience: Audience, chosen: string[] = []): Person[] {
  if (audience === "MIS") return people.filter((p) => p.group === "MIS");
  if (audience === "MAILBOX") return people.filter((p) => p.group === "MAILBOX");
  if (audience === "CHOSEN") {
    const ids = new Set(chosen);
    return people.filter((p) => ids.has(p.employeeId));
  }
  return people;
}

const fill = (t: string, p: { name: string; first: string }) => t.replace(/\{first\}/gi, p.first).replace(/\{name\}/gi, p.name);

/** The email one person gets. Plain text in, a clean HTML email out — no footer. */
export function buildCompanyEmail(subject: string, body: string, p: { name: string; first: string }) {
  const s = fill(subject, p).trim();
  const text = fill(body, p).replace(/\r\n/g, "\n").trim();
  const paras = text
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 12px 0">${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:20px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;padding:24px">
        <tr><td style="font-size:18px;font-weight:700;color:#111827;padding-bottom:14px">${esc(s)}</td></tr>
        <tr><td style="font-size:14px;line-height:1.55;color:#374151">${paras}</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
  return { subject: s, html, text };
}

export interface CompanyEmailInput {
  subject: string;
  body: string;
  audience: Audience;
  employeeIds?: string[];
  /** ISO time to send; empty = now. */
  sendAt?: string | null;
}

function check(input: CompanyEmailInput, now: Date): Date {
  if (!input.subject?.trim() || input.subject.length > 200) throw new MisEmailError(400, "Write a subject (up to 200 characters).");
  if (!input.body?.trim() || input.body.length > 20000) throw new MisEmailError(400, "Write the message.");
  if (!AUDIENCES.includes(input.audience)) throw new MisEmailError(400, "Choose who gets it.");
  if (input.audience === "CHOSEN" && !input.employeeIds?.length) throw new MisEmailError(400, "Pick at least one person.");
  if (!input.sendAt) return now;
  const at = new Date(input.sendAt);
  if (Number.isNaN(at.getTime())) throw new MisEmailError(400, "Invalid date or time.");
  if (at.getTime() < now.getTime() - 60_000) throw new MisEmailError(400, "That time has already passed — choose a later time, or send now.");
  if (at.getTime() > now.getTime() + 366 * 86400_000) throw new MisEmailError(400, "Choose a time within the next year.");
  return at;
}

/** Create (and, if it's for now, start sending) a company email. */
export async function createCompanyEmail(companyId: string, actorId: string, input: CompanyEmailInput, now: Date = new Date()) {
  const sendAt = check(input, now);
  const { people } = await companyPeople(companyId);
  const recipients = pick(people, input.audience, input.employeeIds);
  if (!recipients.length) throw new MisEmailError(400, "Nobody to send to — no one in that group has an email address.");
  const row = await prisma.companyEmail.create({
    data: {
      companyId,
      subject: input.subject.trim(),
      body: input.body,
      audience: input.audience,
      employeeIds: input.audience === "CHOSEN" ? input.employeeIds : undefined,
      sendAt,
      status: "SCHEDULED",
      total: recipients.length,
      createdById: actorId,
    },
  });
  const immediate = sendAt.getTime() <= now.getTime() + 60_000;
  if (immediate) void sendCompanyEmail(row.id, "MANUAL").catch((e) => console.error("[Company email] send failed:", e instanceof Error ? e.message : e));
  return { id: row.id, total: recipients.length, sendAt: sendAt.toISOString(), immediate };
}

/** Send one email to its recipients (claims it first, so it is never sent twice). */
export async function sendCompanyEmail(id: string, trigger: "MANUAL" | "SCHEDULE", now: Date = new Date()): Promise<void> {
  const claimed = await prisma.companyEmail.updateMany({
    where: { id, OR: [{ status: "SCHEDULED" }, { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }] },
    data: { status: "SENDING" },
  });
  if (!claimed.count) return;
  const e = (await prisma.companyEmail.findUnique({ where: { id } }))!;
  const sender = await senderStatus(e.companyId);
  if (!sender.canSend) {
    await prisma.companyEmail.update({ where: { id }, data: { status: "FAILED", error: sender.problem ?? "Sending isn't set up." } });
    return;
  }
  const { people } = await companyPeople(e.companyId);
  const recipients = pick(people, e.audience as Audience, Array.isArray(e.employeeIds) ? (e.employeeIds as string[]) : []);
  // Resume after an interruption: skip people who already got it.
  const done = new Set(
    (await prisma.misEmailLog.findMany({ where: { runId: id, status: "SENT" }, select: { employeeId: true } })).map((r) => r.employeeId),
  );
  let sent = done.size;
  let failed = 0;
  const runDate = businessDateString(now);
  await prisma.companyEmail.update({ where: { id }, data: { total: recipients.length } });
  for (const p of recipients) {
    if (done.has(p.employeeId)) continue;
    const mail = buildCompanyEmail(e.subject, e.body, p);
    let status = "SENT";
    let error: string | null = null;
    try {
      await deliver(e.companyId, { to: p.emails, subject: mail.subject, html: mail.html, text: mail.text });
      sent++;
    } catch (err) {
      status = "FAILED";
      error = err instanceof Error ? err.message.slice(0, 1000) : String(err);
      failed++;
    }
    await prisma.misEmailLog
      .create({ data: { companyId: e.companyId, runId: id, runDate, trigger, kind: "CUSTOM", employeeId: p.employeeId, toEmail: p.emails.join(", "), subject: mail.subject, status, error } })
      .catch(() => undefined);
    await prisma.companyEmail.update({ where: { id }, data: { sent, failed } }); // also marks progress (updatedAt)
    if (GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  await prisma.companyEmail.update({
    where: { id },
    data: { status: sent === 0 && failed > 0 ? "FAILED" : "SENT", sent, failed, sentAt: new Date(), error: failed ? `${failed} could not be sent — see the email log.` : null },
  });
}

let running = false;
/** Scheduler, every minute: send what is due (and resume interrupted sends). */
export async function runDueCompanyEmails(now: Date = new Date()) {
  if (running) return;
  running = true;
  try {
    const due = await prisma.companyEmail.findMany({
      where: { OR: [{ status: "SCHEDULED", sendAt: { lte: now } }, { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }] },
      orderBy: { sendAt: "asc" },
      select: { id: true },
      take: 5,
    });
    for (const d of due) await sendCompanyEmail(d.id, "SCHEDULE", now).catch((e) => console.error("[Company email] scheduled send failed:", e instanceof Error ? e.message : e));
  } catch (e) {
    // Table not there yet (first boot) — try again next minute.
    if (!(e instanceof Error && /CompanyEmail|does not exist/i.test(e.message))) console.error("[Company email] scheduler:", e);
  } finally {
    running = false;
  }
}

export async function cancelCompanyEmail(companyId: string, id: string) {
  const r = await prisma.companyEmail.updateMany({ where: { id, companyId, status: "SCHEDULED" }, data: { status: "CANCELLED" } });
  if (!r.count) throw new MisEmailError(409, "It can't be cancelled — it has already been sent or cancelled.");
}

/** A test copy to one address (e.g. your own) before sending to everyone. */
export async function sendCompanyEmailTest(companyId: string, input: { subject: string; body: string; to: string }) {
  const to = parseEmailList(input.to).filter(isEmail);
  if (!to.length) throw new MisEmailError(400, "Enter an email address for the test.");
  if (!input.subject?.trim() || !input.body?.trim()) throw new MisEmailError(400, "Write the subject and message first.");
  const mail = buildCompanyEmail(input.subject, input.body, { name: "Test", first: "Test" });
  await deliver(companyId, { to, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
  return { to };
}

export async function listCompanyEmails(companyId: string) {
  const [rows, { people, noEmail }] = await Promise.all([
    prisma.companyEmail.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 30 }),
    companyPeople(companyId),
  ]);
  return {
    emails: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      body: r.body,
      audience: r.audience,
      sendAt: r.sendAt.toISOString(),
      status: r.status,
      total: r.total,
      sent: r.sent,
      failed: r.failed,
      error: r.error,
      sentAt: r.sentAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    people: people.map((p) => ({ employeeId: p.employeeId, name: p.name, emails: p.emails, group: p.group })),
    counts: { ALL: people.length, MIS: people.filter((p) => p.group === "MIS").length, MAILBOX: people.filter((p) => p.group === "MAILBOX").length },
    noEmail,
  };
}
