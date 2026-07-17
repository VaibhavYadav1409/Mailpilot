import { prisma } from "../lib/db";

/**
 * Minimal shape of an inbound Email row needed to test whether some outgoing
 * message replies to it. Callers (emailSync.ts) select exactly these columns
 * rather than full Email rows, since this can run over every synced message
 * on an account.
 */
export interface ReplyCandidate {
  id: string;
  gmailMessageId: string;
  threadId: string | null;
  receivedAt: Date;
}

/** Anything with a Gmail threadId + when it was sent — satisfied by both the
 *  local GmailSentMeta in emailSync.ts and any future caller. */
interface GmailSentLike {
  threadId: string;
  internalDate: Date;
}

/**
 * Matches Gmail "Sent" messages to inbound candidates purely by threadId —
 * Gmail already computes real conversation threading server-side, so unlike
 * IMAP there's no need to parse In-Reply-To/References ourselves.
 *
 * A sent message is treated as a reply to every candidate in the same
 * thread that it was sent after (a thread can contain several inbound
 * emails, and a single sent message can legitimately "answer" more than one
 * of them — e.g. a catch-up reply after being CC'd on a few). Returns a map
 * of candidate Email id -> every matched reply timestamp, letting the
 * caller (recordReply) work out first/last response times.
 */
export function matchGmailReplies(sentMessages: GmailSentLike[], candidates: ReplyCandidate[]): Map<string, Date[]> {
  const sentByThread = new Map<string, Date[]>();
  for (const sent of sentMessages) {
    if (!sent.threadId) continue;
    const arr = sentByThread.get(sent.threadId) ?? [];
    arr.push(sent.internalDate);
    sentByThread.set(sent.threadId, arr);
  }

  const result = new Map<string, Date[]>();
  for (const candidate of candidates) {
    if (!candidate.threadId) continue;
    const sentTimes = sentByThread.get(candidate.threadId);
    if (!sentTimes) continue;
    const replies = sentTimes.filter((t) => t.getTime() > candidate.receivedAt.getTime());
    if (replies.length) result.set(candidate.id, replies);
  }
  return result;
}

/**
 * A sent message pulled from an IMAP account's Sent/Sent Items folder,
 * reduced to what reply matching needs. Unlike Gmail, plain IMAP has no
 * server-side thread id — matching has to go through the standard
 * In-Reply-To / References headers (RFC 5322 §3.6.4), each holding one or
 * more Message-IDs of prior messages in the conversation.
 */
export interface ImapSentMessageMeta {
  imapMessageId: string;
  inReplyTo: string[];
  references: string[];
  sentDate: Date;
}

/**
 * Matches IMAP Sent-folder messages to inbound candidates by looking for
 * the candidate's own Message-ID (stored as Email.gmailMessageId for IMAP
 * accounts — see fetchImapMessages in imapSync.ts) inside the sent
 * message's In-Reply-To or References headers.
 */
export function matchImapReplies(sentMessages: ImapSentMessageMeta[], candidates: ReplyCandidate[]): Map<string, Date[]> {
  const candidateByMessageId = new Map<string, ReplyCandidate>();
  for (const candidate of candidates) candidateByMessageId.set(candidate.gmailMessageId, candidate);

  const result = new Map<string, Date[]>();
  for (const sent of sentMessages) {
    const referencedIds = new Set([...sent.inReplyTo, ...sent.references]);
    for (const refId of referencedIds) {
      const candidate = candidateByMessageId.get(refId);
      if (!candidate) continue;
      if (sent.sentDate.getTime() <= candidate.receivedAt.getTime()) continue; // a "reply" can't predate the original

      const arr = result.get(candidate.id) ?? [];
      arr.push(sent.sentDate);
      result.set(candidate.id, arr);
    }
  }
  return result;
}

/**
 * Records that one or more replies were observed for an inbound email —
 * either detected during sync (matchGmailReplies/matchImapReplies) or sent
 * directly through MailPilot (sendReply in emailActions.ts). Both paths
 * funnel through here so firstResponseAt/lastReplyAt/replyTimeSec stay
 * consistent no matter which source answered the thread.
 *
 * Safe to call repeatedly for the same email as new replies come in on
 * later syncs: firstResponseAt only ever moves earlier, lastReplyAt only
 * ever moves later, never overwritten by a later call with fewer/older
 * timestamps.
 */
export async function recordReply(emailId: string, timestamps: Date[]): Promise<void> {
  if (!timestamps.length) return;

  const email = await prisma.email.findUnique({
    where: { id: emailId },
    select: { receivedAt: true, firstResponseAt: true, lastReplyAt: true },
  });
  if (!email) return;

  const observedMin = timestamps.reduce((min, t) => (t < min ? t : min), timestamps[0]);
  const observedMax = timestamps.reduce((max, t) => (t > max ? t : max), timestamps[0]);

  const firstResponseAt =
    email.firstResponseAt && email.firstResponseAt.getTime() < observedMin.getTime() ? email.firstResponseAt : observedMin;
  const lastReplyAt =
    email.lastReplyAt && email.lastReplyAt.getTime() > observedMax.getTime() ? email.lastReplyAt : observedMax;
  const replyTimeSec = Math.max(0, Math.floor((firstResponseAt.getTime() - email.receivedAt.getTime()) / 1000));

  await prisma.email.update({
    where: { id: emailId },
    data: {
      isReplied: true,
      repliedAt: lastReplyAt,
      firstResponseAt,
      lastReplyAt,
      replyTimeSec,
      pendingDurationSec: null, // no longer pending once replied
    },
  });
}

/**
 * Refreshes pendingDurationSec (time-since-received, as of "now") for every
 * still-unreplied email on an account. Run once per sync, after reply
 * detection, so pending-duration numbers reflect the moment of the sync run
 * rather than going stale between syncs.
 */
export async function refreshPendingDurations(accountId: string): Promise<void> {
  const now = new Date();
  const unreplied = await prisma.email.findMany({
    where: { gmailAccountId: accountId, isReplied: false },
    select: { id: true, receivedAt: true },
  });
  if (!unreplied.length) return;

  await prisma.$transaction(
    unreplied.map((e) =>
      prisma.email.update({
        where: { id: e.id },
        data: { pendingDurationSec: Math.max(0, Math.floor((now.getTime() - e.receivedAt.getTime()) / 1000)) },
      })
    )
  );
}
