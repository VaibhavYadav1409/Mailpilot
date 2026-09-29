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
  getMisStatusForDate,
  listMisSources,
  runMisChecks,
  updateMisSource,
} from "../services/misService";
import { MisGraphError, buildMisAuthUrl } from "../services/misMicrosoft";
import { businessDateString } from "../services/msiService";

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
 *   POST   /check                   { employeeId? } re-read now                  (Admin+)
 *   POST   /me/check                re-read the caller's own MIS now             (any employee)
 */
export const misRouter = Router();

const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET as string;

function handle(res: Response, e: unknown) {
  if (e instanceof MisError || e instanceof MisGraphError) return res.status(e.status).json({ error: e.message });
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
    const today = businessDateString();
    const mis = (await getMisStatusForDate(req.user!.companyId, today, req.user!.employeeId)).get(req.user!.employeeId) ?? null;
    return res.json({ reportDate: today, mis });
  } catch (e) {
    return handle(res, e);
  }
});
