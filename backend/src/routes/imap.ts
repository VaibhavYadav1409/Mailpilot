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
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().positive(),
  smtpUser: z.string().min(1),
  smtpPass: z.string().min(1),
  smtpSecure: z.boolean().default(true),
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
