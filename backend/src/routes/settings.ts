import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { requireMinRole } from "../middleware/rbac";

export const settingsRouter = Router();

settingsRouter.get("/", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const settings = await prisma.companySettings.upsert({
    where: { companyId: req.user!.companyId },
    update: {},
    create: { companyId: req.user!.companyId },
  });
  return res.json(settings);
});

const updateSchema = z.object({
  businessHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  businessHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  performanceThreshold: z.number().min(0).max(100).optional(),
  notificationRules: z.record(z.string(), z.unknown()).optional(),
});

// PUT rather than PATCH: matches the admin frontend's existing
// `api.put('/settings', data)` call, so nothing on that side needs to change.
settingsRouter.put("/", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid settings payload" });

  const settings = await prisma.companySettings.upsert({
    where: { companyId: req.user!.companyId },
    update: parsed.data as any,
    create: { companyId: req.user!.companyId, ...parsed.data as any },
  });
  return res.json(settings);
});
