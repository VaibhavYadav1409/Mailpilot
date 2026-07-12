// Temp passwords used to only ever be shown once in-UI, with no way to get
// them to an employee who isn't standing next to the admin. This gives that
// a real (if minimal) delivery path: EMAIL_DRIVER=console just logs — safe
// zero-config default for dev — and EMAIL_DRIVER=smtp sends for real via
// nodemailer once SMTP_* is configured.

interface SendMailArgs {
  to: string;
  subject: string;
  text: string;
}

const driver = (process.env.EMAIL_DRIVER ?? "console").toLowerCase();

export async function sendMail(args: SendMailArgs): Promise<void> {
  if (driver !== "smtp") {
    console.log(`[Email:console] To: ${args.to} | Subject: ${args.subject}\n${args.text}`);
    return;
  }

  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });

  await transport.sendMail({
    from: process.env.SMTP_FROM ?? "MailPilot <no-reply@example.com>",
    to: args.to,
    subject: args.subject,
    text: args.text,
  });
}

export function sendTempPasswordEmail(to: string, tempPassword: string, isReset: boolean) {
  const subject = isReset ? "Your MailPilot password has been reset" : "Welcome to MailPilot";
  const text = isReset
    ? `Your MailPilot password was reset by an administrator.\n\nTemporary password: ${tempPassword}\n\nYou'll be asked to set a new password the next time you sign in.`
    : `Welcome to MailPilot! Your account has been created.\n\nEmail: ${to}\nTemporary password: ${tempPassword}\n\nYou'll be asked to set a new password the next time you sign in.`;

  // Fire-and-forget from the caller's perspective — a slow/broken SMTP
  // server should never block the employee-create/reset response, since the
  // temp password is already returned in that response as a fallback.
  return sendMail({ to, subject, text }).catch((e) => {
    console.error(`[Email] Failed to send to ${to}:`, e);
  });
}
