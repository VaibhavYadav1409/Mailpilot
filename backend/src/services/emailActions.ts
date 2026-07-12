import nodemailer from "nodemailer";
import { prisma } from "../lib/db";
import { getValidAccessToken } from "./gmailAccountService";
import { decryptToken } from "../lib/crypto";

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

async function sendViaSmtp(
  account: { smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean | null; smtpUser: string | null; refreshToken: string },
  opts: { to: string; from: string; subject: string; body: string; attachments?: ReplyAttachment[] }
) {
  if (!account.smtpHost || !account.smtpPort || !account.smtpUser) {
    throw new Error("This mailbox is missing SMTP connection details. Please reconnect.");
  }
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure ?? true,
    auth: { user: account.smtpUser, pass: decryptToken(account.refreshToken) },
  });
  await transport.sendMail({
    to: opts.to,
    from: opts.from,
    subject: opts.subject,
    text: opts.body,
    attachments: (opts.attachments ?? []).map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.data, "base64"),
      contentType: a.mimeType,
    })),
  });
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
  } else {
    await sendViaSmtp(email.gmailAccount, {
      to: email.fromAddress,
      from: email.gmailAccount.emailAddress,
      subject,
      body,
      attachments: opts.attachments,
    });
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

  await prisma.email.update({ where: { id: emailId }, data: { isReplied: true, repliedAt: sentAt } });

  return reply;
}
