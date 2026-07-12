import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth";
import { buildAuthUrl, isGoogleConfigured } from "../services/googleOAuth";
import { connectGmailAccount, disconnectGmailAccount } from "../services/gmailAccountService";
import { prisma } from "../lib/db";

export const gmailRouter = Router();

const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET;
if (!OAUTH_STATE_SECRET) {
  throw new Error("OAUTH_STATE_SECRET env var is required");
}

/**
 * GET /api/gmail/connect
 * Starts the OAuth flow. The `state` param is a short-lived signed JWT
 * carrying the caller's employeeId — this is what ties the eventual
 * /callback hit back to the right employee without trusting anything the
 * client sends at callback time, and prevents an attacker from tricking a
 * victim into connecting the attacker's Gmail account to the victim's
 * employee record (state-based CSRF protection, standard for OAuth).
 */
gmailRouter.get("/connect", requireAuth, (req, res) => {
  const state = jwt.sign(
    { employeeId: req.user!.employeeId, companyId: req.user!.companyId },
    OAUTH_STATE_SECRET as string,
    { expiresIn: "10m" }
  );
  res.json({ authUrl: buildAuthUrl(state) });
});

// Redirects target the employee-app's SPA root ("/") rather than a
// server-rendered /settings/gmail page — the employee-app only has "/",
// "/login", and "/404" (see employee-app/src/App.tsx) and Home.tsx already
// reads these exact query params (?synced=1, ?error=gmail_auth_failed,
// ?error=google_not_configured) off "/".
const EMPLOYEE_APP_URL = process.env.EMPLOYEE_APP_URL || "http://localhost:3002";

gmailRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${EMPLOYEE_APP_URL}/?error=gmail_auth_failed`);
  }
  if (typeof code !== "string" || typeof state !== "string") {
    return res.status(400).send("Missing code or state");
  }

  let payload: { employeeId: string; companyId: string };
  try {
    payload = jwt.verify(state, OAUTH_STATE_SECRET as string) as typeof payload;
  } catch {
    return res.status(400).send("Invalid or expired OAuth state — please retry connecting Gmail.");
  }

  try {
    await connectGmailAccount(payload.employeeId, payload.companyId, code);
    return res.redirect(`${EMPLOYEE_APP_URL}/?synced=1`);
  } catch (err: any) {
    return res.redirect(`${EMPLOYEE_APP_URL}/?error=${encodeURIComponent(err.message)}`);
  }
});

gmailRouter.post("/disconnect", requireAuth, async (req, res) => {
  await disconnectGmailAccount(req.user!.employeeId);
  return res.json({ success: true });
});

gmailRouter.get("/status", requireAuth, async (req, res) => {
  const account = await prisma.gmailAccount.findUnique({
    where: { employeeId: req.user!.employeeId },
    select: { emailAddress: true, status: true, lastSyncedAt: true, provider: true },
  });
  const connected = !!account && account.status === "CONNECTED";
  return res.json({
    account,
    connected,
    email: account?.emailAddress ?? null,
    provider: account?.provider?.toLowerCase() ?? null,
    googleConfigured: isGoogleConfigured(),
  });
});
