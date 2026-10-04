import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireMinRole } from "../middleware/rbac";
import {
  MisError,
  createMisSource,
  deleteMisSource,
  disconnectMis,
  getMisConnection,
  importMisRows,
  listMisSources,
  runMisChecks,
  updateMisSource,
} from "../services/misService";
import { MisGraphError, buildMisAuthUrl } from "../services/misMicrosoft";
import { getMisDaysForEmployee } from "../services/msiService";
import { CircleError, circleWorkbook, getCircleMonth, setCircleMark } from "../services/misCircle";
import { HolidayError, MARKET_HOLIDAYS, MARKET_HOLIDAY_SOURCE, listHolidays, setHoliday } from "../services/workCalendar";
import { emitToCompany } from "../sockets";
import {
  MisEmailError,
  bulkSetEmails,
  getEmailSettings,
  listRecipients,
  previewEmail,
  recentEmailLog,
  rotateCronToken,
  runMisEmails,
  senderStatus,
  setRecipientEmail,
  triggerFromCron,
  updateEmailSettings,
} from "../services/misEmail";

/**
 * MIS auto-check — /api/mis
 *
 *   GET    /connection              Microsoft account used to read MIS sheets     (Admin+)
 *   POST   /connection/start        -> { authUrl } to connect it                  (Admin+)
 *   DELETE /connection              disconnect                                   (Admin+)
 *   GET    /sources                 every linked MIS spreadsheet + today's result (Admin+)
 *   POST   /sources                 { employeeId, label, shareUrl, sheetName?, requiredColumns? }
 *   PATCH  /sources/:id             same fields, all optional; requiredColumns: [] = automatic
 *   DELETE /sources/:id
 *   POST   /import                  { rows: [{ name, url, checkedBy?, approvedBy?, username? }] } (Admin+)
 *   POST   /check                   { employeeId? } re-read now                  (Admin+)
 *   POST   /me/check                re-read the caller's own MIS now             (any employee)
 *   GET    /circle?month=YYYY-MM    monthly Circle Report (red circles, salary deduction)  (Admin+)
 *   GET    /circle/export?month=&employeeId=  Excel file (everyone, or one person) (Admin+)
 *   PUT    /circle/mark             { employeeId, date, code|null, note? } override one cell (Admin+)
 *   GET    /me/circle?month=        the caller's own row                          (any employee)
 *   GET    /me/circle/export?month= the caller's own Excel file                   (any employee)
 *   GET    /holidays?year=          NSE trading holidays + company holidays      (any employee)
 *   PUT    /holidays                { date, name?, isOff } add / switch a holiday  (Admin+)
 *   DELETE /holidays/:date          back to the default for that date            (Admin+)
 *   GET    /email                   nightly email: settings, sender, recipients, cron URL (Admin+)
 *   PUT    /email/settings          { enabled, sendTime, audience, skipOffDays, hrSummary, hrEmails, subject, intro, footer }
 *   PUT    /email/recipients/:id    { email|null } one person's email address     (Admin+)
 *   POST   /email/recipients/bulk   { rows: [{ name, email }] }                   (Admin+)
 *   GET    /email/preview?employeeId=  the email that person would get now     (Admin+)
 *   POST   /email/test              { to } one sample email                      (Admin+)
 *   POST   /email/send-now          send to everyone now                         (Admin+)
 *   POST   /email/cron-token        new secret link (old one stops working)      (Admin+)
 *   GET    /email/log               what was sent                                (Admin+)
 *   GET|POST /email/cron/:token     for cron-job.org — no login; the token is the secret
 */
export const misRouter = Router();

const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET as string;

function handle(res: Response, e: unknown) {
  if (e instanceof MisError || e instanceof MisGraphError || e instanceof CircleError || e instanceof HolidayError || e instanceof MisEmailError)
    return res.status(e.status).json({ error: e.message });
  console.error("[MIS] request failed:", e);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}

/** The admin site that started the connect flow — only an allowed CORS origin, so the callback can't be used as an open redirect. */
function allowedReturnOrigin(req: Request): string | null {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
  const allowed = (process.env.CORS_ORIGIN ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (origin && (allowed.length === 0 || allowed.includes(origin.replace(/\/$/, "")))) return origin.replace(/\/$/, "");
  return process.env.ADMIN_APP_URL?.replace(/\/$/, "") ?? allowed[0] ?? null;
}

misRouter.get("/connection", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    return res.json(await getMisConnection(req.user!.companyId));
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.post("/connection/start", requireAuth, requireMinRole("ADMIN"), (req, res) => {
  try {
    const state = jwt.sign(
      {
        purpose: "mis",
        employeeId: req.user!.employeeId,
        companyId: req.user!.companyId,
        returnTo: allowedReturnOrigin(req),
        page: req.body?.page === "mis-email" ? "mis-email" : "employees",
      },
      OAUTH_STATE_SECRET,
      { expiresIn: "10m" },
    );
    return res.json({ authUrl: buildMisAuthUrl(state) });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.delete("/connection", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    await disconnectMis(req.user!.companyId);
    return res.json({ success: true });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.get("/sources", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    return res.json({ sources: await listMisSources(req.user!.companyId) });
  } catch (e) {
    return handle(res, e);
  }
});

const sourceSchema = z.object({
  employeeId: z.string().uuid().optional(),
  label: z.string().max(80).optional(),
  shareUrl: z.string().max(4000).optional(),
  sheetName: z.string().max(120).nullish(),
  dateColumn: z.string().max(120).nullish(),
  requiredColumns: z.array(z.string().max(300)).max(300).nullish(),
  checkedBy: z.string().max(80).nullish(),
  approvedBy: z.string().max(80).nullish(),
});

const importSchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string().max(200),
        url: z.string().max(4000),
        checkedBy: z.string().max(80).nullish(),
        approvedBy: z.string().max(80).nullish(),
        username: z.string().max(80).nullish(),
      }),
    )
    .min(1)
    .max(300),
});

misRouter.post("/import", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = importSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Nothing to import — paste rows with a name and a link." });
  try {
    return res.json({ results: await importMisRows(req.user!.companyId, body.data.rows) });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.post("/sources", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = sourceSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request." });
  try {
    const id = await createMisSource(req.user!.companyId, body.data);
    return res.status(201).json({ id });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.patch("/sources/:id", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = sourceSchema.safeParse(req.body);
  if (!body.success || !z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Invalid request." });
  try {
    await updateMisSource(req.user!.companyId, req.params.id, body.data);
    return res.json({ success: true });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.delete("/sources/:id", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "MIS file not found." });
  try {
    await deleteMisSource(req.user!.companyId, req.params.id);
    return res.json({ success: true });
  } catch (e) {
    return handle(res, e);
  }
});

/** Waits for a check, but never longer than `ms` — the result lands via msi:updated anyway. */
async function withinMs(p: Promise<unknown>, ms: number) {
  await Promise.race([p.catch((e) => console.error("[MIS] check failed:", e)), new Promise((r) => setTimeout(r, ms))]);
}

misRouter.post("/check", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId : undefined;
  try {
    await withinMs(runMisChecks(req.user!.companyId, { employeeId, force: true }), 25_000);
    return res.json({ sources: await listMisSources(req.user!.companyId) });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.post("/me/check", requireAuth, async (req, res) => {
  try {
    // Not forced: a source read less than a minute ago is not read again.
    await withinMs(runMisChecks(req.user!.companyId, { employeeId: req.user!.employeeId }), 20_000);
    const misDays = await getMisDaysForEmployee({ employeeId: req.user!.employeeId, companyId: req.user!.companyId });
    return res.json({ misDays });
  } catch (e) {
    return handle(res, e);
  }
});

// ---------------------------------------------------------------------------
// Circle Report
// ---------------------------------------------------------------------------

const monthParam = (req: Request) => (typeof req.query.month === "string" ? req.query.month : undefined);

misRouter.get("/circle", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    return res.json(await getCircleMonth(req.user!.companyId, monthParam(req)));
  } catch (e) {
    return handle(res, e);
  }
});

/** Sends the month (everyone, or one person) as an .xlsx download. */
async function sendCircleExcel(req: Request, res: Response, employeeId?: string) {
  const data = await getCircleMonth(req.user!.companyId, monthParam(req), { employeeId });
  if (employeeId && data.rows.length === 0) throw new CircleError(404, "This person isn't on the Circle Report.");
  const person = employeeId ? data.rows[0].name : undefined;
  const file = circleWorkbook(data, { person });
  const safe = (t: string) => t.replace(/[^\w .-]+/g, " ").replace(/\s+/g, " ").trim();
  const name = `MIS CIRCLE REPORT ${data.month}${person ? ` - ${safe(person.toUpperCase())}` : ""}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Length", String(file.length));
  res.setHeader("Content-Disposition", `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Cache-Control", "private, no-store");
  return res.end(file);
}

misRouter.get("/circle/export", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    const employeeId = typeof req.query.employeeId === "string" && req.query.employeeId ? req.query.employeeId : undefined;
    if (employeeId && !z.string().uuid().safeParse(employeeId).success) return res.status(400).json({ error: "Invalid person." });
    return await sendCircleExcel(req, res, employeeId);
  } catch (e) {
    return handle(res, e);
  }
});

const markSchema = z.object({
  employeeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  code: z.string().max(5).nullable(),
  note: z.string().max(300).nullish(),
});

misRouter.put("/circle/mark", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = markSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request." });
  try {
    await setCircleMark(req.user!.companyId, req.user!.employeeId, body.data);
    return res.json({ success: true });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.get("/me/circle", requireAuth, async (req, res) => {
  try {
    const data = await getCircleMonth(req.user!.companyId, monthParam(req), { employeeId: req.user!.employeeId });
    return res.json({ ...data, row: data.rows[0] ?? null });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.get("/me/circle/export", requireAuth, async (req, res) => {
  try {
    return await sendCircleExcel(req, res, req.user!.employeeId);
  } catch (e) {
    return handle(res, e);
  }
});

// ---------------------------------------------------------------------------
// Holidays (working calendar)
// ---------------------------------------------------------------------------

misRouter.get("/holidays", requireAuth, async (req, res) => {
  try {
    const y = Number(typeof req.query.year === "string" ? req.query.year : new Date().getFullYear());
    if (!Number.isInteger(y) || y < 2020 || y > 2100) return res.status(400).json({ error: "Invalid year." });
    return res.json({
      year: y,
      holidays: await listHolidays(req.user!.companyId, y),
      source: MARKET_HOLIDAY_SOURCE,
      weeklyOff: "Every Sunday, and the 2nd Saturday of every month.",
    });
  } catch (e) {
    return handle(res, e);
  }
});

const holidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().max(120).nullish(),
  isOff: z.boolean(),
});

misRouter.put("/holidays", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = holidaySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request." });
  try {
    await setHoliday(req.user!.companyId, req.user!.employeeId, body.data);
    emitToCompany(req.user!.companyId, "msi:updated", { source: "mis-holidays" });
    return res.json({ success: true });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.delete("/holidays/:date", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date." });
  try {
    // Built-in holiday: switched back on; company holiday: removed.
    await setHoliday(req.user!.companyId, req.user!.employeeId, MARKET_HOLIDAYS[date] ? { date, isOff: true, name: null } : { date, isOff: false });
    emitToCompany(req.user!.companyId, "msi:updated", { source: "mis-holidays" });
    return res.json({ success: true });
  } catch (e) {
    return handle(res, e);
  }
});

// ---------------------------------------------------------------------------
// Nightly MIS email
// ---------------------------------------------------------------------------

/** Public URL of this backend (behind Render's proxy). */
function apiBase(req: Request): string {
  const env = process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (env) return env.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

misRouter.get("/email", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    const companyId = req.user!.companyId;
    const [settings, sender, recipients] = await Promise.all([getEmailSettings(companyId), senderStatus(companyId), listRecipients(companyId)]);
    const { cronToken, ...rest } = settings;
    return res.json({
      settings: rest,
      sender,
      recipients,
      cronUrl: `${apiBase(req)}/api/mis/email/cron/${cronToken}`,
      timezone: "Asia/Kolkata",
    });
  } catch (e) {
    return handle(res, e);
  }
});

const emailSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  sendTime: z.string().max(5).optional(),
  audience: z.enum(["ALL", "ISSUES"]).optional(),
  skipOffDays: z.boolean().optional(),
  hrSummary: z.boolean().optional(),
  hrEmails: z.string().max(2000).nullish(),
  subject: z.string().max(150).nullish(),
  intro: z.string().max(2000).nullish(),
  footer: z.string().max(1000).nullish(),
});

misRouter.put("/email/settings", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = emailSettingsSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid settings." });
  try {
    const s = await updateEmailSettings(req.user!.companyId, req.user!.employeeId, body.data);
    const { cronToken: _t, ...rest } = s;
    return res.json({ settings: rest });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.put("/email/recipients/:employeeId", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = z.object({ email: z.string().max(200).nullable() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request." });
  try {
    await setRecipientEmail(req.user!.companyId, String(req.params.employeeId), body.data.email);
    return res.json({ success: true });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.post("/email/recipients/bulk", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = z.object({ rows: z.array(z.object({ name: z.string().max(200), email: z.string().max(200) })).max(500) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request." });
  try {
    return res.json(await bulkSetEmails(req.user!.companyId, body.data.rows));
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.get("/email/preview", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    const employeeId = typeof req.query.employeeId === "string" && req.query.employeeId ? req.query.employeeId : undefined;
    return res.json(await previewEmail(req.user!.companyId, employeeId));
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.post("/email/test", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const body = z.object({ to: z.string().max(200), employeeId: z.string().uuid().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Enter the email address to send the test to." });
  try {
    return res.json(await runMisEmails(req.user!.companyId, { trigger: "TEST", testTo: body.data.to, employeeId: body.data.employeeId }));
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.post("/email/send-now", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    const companyId = req.user!.companyId;
    const sender = await senderStatus(companyId);
    if (!sender.canSend) return res.status(409).json({ error: sender.problem ?? "Email sending isn't set up." });
    void runMisEmails(companyId, { trigger: "MANUAL" }).catch((e) => console.error("[MIS email] manual run failed:", e instanceof Error ? e.message : e));
    return res.status(202).json({ accepted: true, note: "Sending now — this takes about 3 seconds per person. Refresh the log below to see progress." });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.post("/email/cron-token", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    const s = await rotateCronToken(req.user!.companyId);
    return res.json({ cronUrl: `${apiBase(req)}/api/mis/email/cron/${s.cronToken}` });
  } catch (e) {
    return handle(res, e);
  }
});

misRouter.get("/email/log", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  try {
    return res.json({ log: await recentEmailLog(req.user!.companyId) });
  } catch (e) {
    return handle(res, e);
  }
});

// cron-job.org (or any outside scheduler) — no login, the token in the URL is the secret.
misRouter.all("/email/cron/:token", async (req, res) => {
  try {
    const r = await triggerFromCron(String(req.params.token), { force: req.query.force === "1" });
    return res.status(r.accepted ? 202 : 200).json(r);
  } catch (e) {
    return handle(res, e);
  }
});
