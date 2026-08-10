import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth";
import { buildAuthUrl, isMicrosoftConfigured } from "../services/microsoftOAuth";
import { connectOutlookAccount } from "../services/outlookAccountService";
import { disconnectGmailAccount } from "../services/gmailAccountService";
import { prisma } from "../lib/db";

export const outlookRouter = Router();

const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET;
if (!OAUTH_STATE_SECRET) {
  throw new Error("OAUTH_STATE_SECRET env var is required");
}

/**
 * GET /api/outlook/connect
 * Starts the Microsoft OAuth flow. `state` is a short-lived signed JWT
 * carrying the caller's employeeId so /callback can be tied back to the
 * right employee without trusting client input (CSRF protection) — same
 * pattern as the Gmail flow.
 */
outlookRouter.get("/connect", requireAuth, (req, res) => {
  const state = jwt.sign(
    { employeeId: req.user!.employeeId, companyId: req.user!.companyId },
    OAUTH_STATE_SECRET as string,
    { expiresIn: "10m" }
  );
  res.json({ authUrl: buildAuthUrl(state) });
});

const EMPLOYEE_APP_URL = process.env.EMPLOYEE_APP_URL || "http://localhost:3002";

outlookRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    // Microsoft sends the useful part in error_description (e.g. an AADSTS
    // code explaining a consent/permission refusal). Pass it through instead
    // of collapsing every failure to a generic code, otherwise the user just
    // bounces back to the app with nothing to act on.
    const description = typeof req.query.error_description === "string" ? req.query.error_description : String(error);
    console.error("[outlook] OAuth callback returned an error:", error, description);
    return res.redirect(`${EMPLOYEE_APP_URL}/?error=${encodeURIComponent(description)}`);
  }
  if (typeof code !== "string" || typeof state !== "string") {
    return res.status(400).send("Missing code or state");
  }

  let payload: { employeeId: string; companyId: string };
  try {
    payload = jwt.verify(state, OAUTH_STATE_SECRET as string) as typeof payload;
  } catch {
    return res.status(400).send("Invalid or expired OAuth state — please retry connecting Outlook.");
  }

  try {
    await connectOutlookAccount(payload.employeeId, payload.companyId, code);
    return res.redirect(`${EMPLOYEE_APP_URL}/?synced=1`);
  } catch (err: any) {
    console.error("[outlook] Failed to connect account:", err);
    return res.redirect(`${EMPLOYEE_APP_URL}/?error=${encodeURIComponent(err.message)}`);
  }
});

outlookRouter.post("/disconnect", requireAuth, async (req, res) => {
  // disconnectGmailAccount deactivates whichever provider is currently
  // active for the employee, so it works for OUTLOOK accounts too.
  await disconnectGmailAccount(req.user!.employeeId);
  return res.json({ success: true });
});

outlookRouter.get("/status", requireAuth, async (req, res) => {
  return res.json({ microsoftConfigured: isMicrosoftConfigured() });
});
