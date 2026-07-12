import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { requireMinRole } from "../middleware/rbac";
import { runNotificationRules } from "../services/notificationEngine";

export const notificationsRouter = Router();

const listQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

/** Manager+ — these are admin/manager-facing alerts, not something a plain Employee needs surfaced. */
notificationsRouter.get("/", requireAuth, requireMinRole("MANAGER"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query params" });

  const notifications = await prisma.notification.findMany({
    where: {
      companyId: req.user!.companyId,
      ...(parsed.data.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit,
  });
  return res.json(notifications);
});

notificationsRouter.patch("/:id/read", requireAuth, requireMinRole("MANAGER"), async (req, res) => {
  const existing = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.companyId !== req.user!.companyId) {
    return res.status(404).json({ error: "Notification not found" });
  }
  const notification = await prisma.notification.update({
    where: { id: req.params.id },
    data: { readAt: new Date() },
  });
  return res.json(notification);
});

notificationsRouter.post("/read-all", requireAuth, requireMinRole("MANAGER"), async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { companyId: req.user!.companyId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.json({ updated: result.count });
});

/**
 * Manually triggers the notification rules engine for the caller's company.
 * Same rationale as POST /api/analytics/rollup/run — belongs behind a
 * scheduler in production (see scheduler.ts), this is the manual escape
 * hatch, locked to Admin+.
 */
notificationsRouter.post("/rules/run", requireAuth, requireMinRole("ADMIN"), async (req, res) => {
  const result = await runNotificationRules(req.user!.companyId);
  return res.json(result);
});
