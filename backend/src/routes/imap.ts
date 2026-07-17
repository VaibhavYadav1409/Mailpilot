import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { connectImapAccount } from "../services/imapAccountService";

export const imapRouter = Router();

const connectSchema = z.object({
  email: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().positive(),
  imapUser: z.string().min(1),
  imapPass: z.string().min(1),
  imapSecure: z.boolean().default(true),
  // Optional: IMAP mailboxes never send through MailPilot (see
  // IMAP_SEND_DISABLED_MESSAGE in emailActions.ts), so SMTP details are
  // never verified and aren't required to connect a read-only mailbox.
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().positive().optional(),
  smtpUser: z.string().min(1).optional(),
  smtpPass: z.string().min(1).optional(),
  smtpSecure: z.boolean().default(true).optional(),
});

// POST /api/auth/imap — verifies the credentials by actually connecting,
// then stores them. Mounted directly (not nested under /gmail) so it
// matches the employee-app's ImapConnectDialog, which posts to this exact
// path.
imapRouter.post("/imap", requireAuth, async (req, res) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid IMAP/SMTP details" });
  }

  try {
    const account = await connectImapAccount(req.user!.employeeId, req.user!.companyId, parsed.data);
    return res.json({ success: true, account });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Failed to connect. Check your credentials and try again." });
  }
});
