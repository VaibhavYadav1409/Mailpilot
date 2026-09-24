import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireMinRole } from "../middleware/rbac";
import {
  MsiError,
  applyAdminFilter,
  createTodayReport,
  deleteOwnReport,
  getAdminOverview,
  getRecentForEmployee,
  getTodayForEmployee,
  loadReportFileForDownload,
  updateOwnReport,
  type MsiActor,
  type MsiAdminFilter,
} from "../services/msiService";

/**
 * MSI Daily Work Report API — mounted at /api/msi (see server.ts).
 *
 * Employee (any authenticated user, own data only):
 *   GET    /reports/today            today's status + upload rules
 *   GET    /reports/my-reports       today + yesterday (the only days that can still exist)
 *   POST   /reports                  submit today's report  { file: {fileName, dataBase64}, importantMessage? }
 *   PATCH  /reports/:id              update today's report  { file?, importantMessage? }   (PUT is an alias)
 *   DELETE /reports/:id              withdraw today's report
 *   GET    /reports/:id/download     download own report
 *
 * CEO / admin (ADMIN, COO, CEO — company-wide):
 *   GET    /admin/summary?date=YYYY-MM-DD
 *   GET    /admin/reports?date=YYYY-MM-DD&filter=all|submitted|not_submitted|important
 *   GET    /admin/reports/:id/download
 *
 * Files travel as base64 inside JSON — the same pattern the compose/reply
 * attachment upload already uses — so no multipart library is added. The
 * global express.json limit (25mb) comfortably covers MSI_MAX_FILE_MB.
 * Storage keys/paths are never returned; downloads stream through here.
 */
export const msiRouter = Router();

const fileSchema = z.object({
  fileName: z.string().min(1).max(500),
  dataBase64: z.string().min(1),
});

const createSchema = z.object({
  file: fileSchema.nullish(),
  importantMessage: z.string().max(10_000).nullish(),
});

const updateSchema = z.object({
  file: fileSchema.nullish(),
  importantMessage: z.string().max(10_000).nullish(),
});

const idSchema = z.string().uuid();

function actorOf(req: Request): MsiActor {
  return { employeeId: req.user!.employeeId, companyId: req.user!.companyId };
}

/** Maps service errors to clean JSON; anything unexpected becomes a generic message (details only in server logs). */
function handleError(res: Response, e: unknown, fallback = "Something went wrong. Please try again.") {
  if (e instanceof MsiError) {
    const body: Record<string, unknown> = { error: e.message, code: e.code };
    const withReport = e as MsiError & { report?: unknown };
    if (withReport.report) body.report = withReport.report;
    return res.status(e.status).json(body);
  }
  console.error("[MSI] request failed:", e);
  return res.status(500).json({ error: fallback });
}

function sendFile(res: Response, file: { fileName: string; fileType: string; data: Buffer }) {
  const asciiName = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Type", file.fileType);
  res.setHeader("Content-Length", String(file.data.length));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.end(file.data);
}

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

msiRouter.get("/reports/today", requireAuth, async (req, res) => {
  try {
    return res.json(await getTodayForEmployee(actorOf(req)));
  } catch (e) {
    return handleError(res, e);
  }
});

msiRouter.get("/reports/my-reports", requireAuth, async (req, res) => {
  try {
    return res.json(await getRecentForEmployee(actorOf(req)));
  } catch (e) {
    return handleError(res, e);
  }
});

msiRouter.post("/reports", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please select your daily report.", code: "NO_FILE" });
  try {
    const report = await createTodayReport(actorOf(req), parsed.data);
    return res.status(201).json({ report });
  } catch (e) {
    return handleError(res, e, "Upload failed. Please try again.");
  }
});

async function handleUpdate(req: Request, res: Response) {
  if (!idSchema.safeParse(req.params.id).success) return res.status(404).json({ error: "Report not found." });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update.", code: "BAD_REQUEST" });
  try {
    const report = await updateOwnReport(actorOf(req), req.params.id, parsed.data);
    return res.json({ report });
  } catch (e) {
    return handleError(res, e, "Upload failed. Please try again.");
  }
}
msiRouter.patch("/reports/:id", requireAuth, handleUpdate);
msiRouter.put("/reports/:id", requireAuth, handleUpdate);

msiRouter.delete("/reports/:id", requireAuth, async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(404).json({ error: "Report not found." });
  try {
    await deleteOwnReport(actorOf(req), req.params.id);
    return res.status(204).end();
  } catch (e) {
    return handleError(res, e);
  }
});

msiRouter.get("/reports/:id/download", requireAuth, async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(404).json({ error: "Report not found." });
  try {
    return sendFile(res, await loadReportFileForDownload(actorOf(req), req.params.id, "own"));
  } catch (e) {
    return handleError(res, e, "Download failed. Please try again.");
  }
});

// ---------------------------------------------------------------------------
// CEO / admin
// ---------------------------------------------------------------------------

const adminQuerySchema = z.object({
  date: z.string().optional(),
  filter: z.enum(["all", "submitted", "not_submitted", "important"]).optional(),
});

msiRouter.get("/admin/summary", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const q = adminQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Invalid request." });
  try {
    const { date, today, expired, summary } = await getAdminOverview(req.user!.companyId, q.data.date);
    return res.json({ date, today, expired, summary });
  } catch (e) {
    return handleError(res, e);
  }
});

msiRouter.get("/admin/reports", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const q = adminQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Invalid request." });
  try {
    const overview = await getAdminOverview(req.user!.companyId, q.data.date);
    return res.json(applyAdminFilter(overview, (q.data.filter ?? "all") as MsiAdminFilter));
  } catch (e) {
    return handleError(res, e);
  }
});

msiRouter.get("/admin/reports/:id/download", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  if (!idSchema.safeParse(req.params.id).success) return res.status(404).json({ error: "Report not found." });
  try {
    return sendFile(res, await loadReportFileForDownload(actorOf(req), req.params.id, "admin"));
  } catch (e) {
    return handleError(res, e, "Download failed. Please try again.");
  }
});
