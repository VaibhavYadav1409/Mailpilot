import { prisma } from "../lib/db";
import { getValidAccessToken } from "./gmailAccountService";
import { recordReply } from "./replyTracking";

// Conditional Sending business rule (see project spec "Conditional Sending
// Based on Account Type"): IMAP/SMTP-connected mailboxes are read-only in
// MailPilot, full stop — no SMTP send, no Resend relay, regardless of how
// much SMTP detail is on file or which IMAP_SEND_DRIVER is configured.
// Employees reply from their own client (Gmail Web, Outlook, Apple Mail,
// etc.) and MailPilot detects those replies during sync instead. Only a
// connected GMAIL (OAuth) account can send through MailPilot.
//
// Mirrored in employee-app/src/pages/Home.tsx as FALLBACK_SEND_DISABLED_MESSAGE
// and served as the source of truth via GET /api/gmail/status#sendDisabledMessage.
export const IMAP_SEND_DISABLED_MESSAGE =
  "Sending emails from MailPilot is not available for IMAP accounts. Please reply using your preferred email client. MailPilot will automatically sync and track your replies.";

export interface ReplyAttachment {
  filename: string;
  mimeType: string;
  data: string; // base64, no data: prefix
}

function buildRawMime(opts: { to: string; from: string; subject: string; body: string; attachments?: ReplyAttachment[] }): string {
  const attachments = opts.attachments ?? [];
  let message: string;

  if (attachments.length === 0) {
    message = [
      `To: ${opts.to}`,
      `From: ${opts.from}`,
      `Subject: ${opts.subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      "",
      opts.body,
    ].join("\r\n");
  } else {
    const boundary = `mp_${Date.now()}_boundary`;
    const parts = [
      `To: ${opts.to}`,
      `From: ${opts.from}`,
      `Subject: ${opts.subject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      "",
      opts.body,
      "",
    ];
    for (const att of attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        `Content-Transfer-Encoding: base64`,
        "",
        att.data,
        ""
      );
    }
    parts.push(`--${boundary}--`);
    message = parts.join("\r\n");
  }

  // Gmail's API wants URL-safe base64, no padding.
  return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendViaGmail(
  employeeId: string,
  opts: { to: string; from: string; subject: string; body: string; threadId?: string; attachments?: ReplyAttachment[] }
) {
  const accessToken = await getValidAccessToken(employeeId);
  if (!accessToken) throw new Error("Gmail account is not connected. Please reconnect.");

  const raw = buildRawMime(opts);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, threadId: opts.threadId }),
  });
  if (!res.ok) throw new Error(`Failed to send reply: ${await res.text()}`);
}

/**
 * Sends a reply to an email and records it as a Reply row so analytics can
 * compute real reply times — this is the one place `replyTimeSec` is
 * calculated, always server-side from receivedAt/sentAt, never trusted from
 * the client.
 */
export async function sendReply(
  employeeId: string,
  emailId: string,
  body: string,
  opts: { wasAIDraft: boolean; wasAIEdited: boolean; attachments?: ReplyAttachment[] }
) {
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: { gmailAccount: true },
  });
  if (!email) throw new Error("Email not found");
  if (email.gmailAccount.employeeId !== employeeId) {
    throw new Error("This email does not belong to your connected mail account");
  }
  if (!email.gmailAccount.isActive) {
    // Account switching: this email was synced from a mailbox the employee
    // has since moved away from (see isActive on GmailAccount). Sending
    // would use the *currently* active account's credentials via
    // getValidAccessToken(employeeId) below, which don't belong to this
    // email's thread — so this has to be blocked rather than silently
    // sending from the wrong mailbox.
    throw new Error("This email is from a mail account that's no longer active. Reconnect it to reply.");
  }

  const subject = email.subject ? `Re: ${email.subject.replace(/^Re:\s*/i, "")}` : "Re:";

  if (email.gmailAccount.provider === "MANUAL") {
    throw new Error("This email was pasted manually and has no connected mailbox to send from.");
  } else if (email.gmailAccount.provider === "GMAIL") {
    await sendViaGmail(employeeId, {
      to: email.fromAddress,
      from: email.gmailAccount.emailAddress,
      subject,
      body,
      threadId: email.threadId ?? undefined,
      attachments: opts.attachments,
    });
  } else if (email.gmailAccount.provider === "IMAP") {
    // Conditional Sending: IMAP mailboxes are read-only in MailPilot,
    // regardless of SMTP details on file or IMAP_SEND_DRIVER config.
    throw new Error(IMAP_SEND_DISABLED_MESSAGE);
  } else {
    throw new Error("This mailbox has no connected send path.");
  }

  const sentAt = new Date();
  const replyTimeSec = Math.max(0, Math.floor((sentAt.getTime() - email.receivedAt.getTime()) / 1000));

  const reply = await prisma.reply.create({
    data: {
      emailId,
      employeeId,
      wasAIDraft: opts.wasAIDraft,
      wasAIEdited: opts.wasAIEdited,
      sentAt,
      replyTimeSec,
    },
  });

  // Funnels through the same code path sync-detected replies use, so
  // firstResponseAt/lastReplyAt/replyTimeSec/pendingDurationSec stay
  // consistent regardless of which source (MailPilot or an external client)
  // answered the thread.
  await recordReply(emailId, [sentAt]);

  return reply;
}
