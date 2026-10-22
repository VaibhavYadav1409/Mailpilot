/**
 * Accounts marked "needs reconnect" (REVOKED) are never synced again, so a
 * wrong call would leave a mailbox dead forever. Every few hours this tries
 * each one again once: if the sign-in works, the account is CONNECTED again
 * (no one has to do anything); if not, the reason is refreshed for the
 * admin page. No new notifications are sent for repeat failures.
 */
import { prisma } from "../lib/db";
import { decryptToken, encryptToken } from "../lib/crypto";
import { emitToCompany } from "../sockets";
import { refreshAccessToken as refreshGoogle } from "./googleOAuth";
import { refreshAccessToken as refreshMicrosoft } from "./microsoftOAuth";

const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

export async function retryRevokedAccounts(now: Date = new Date()): Promise<{ tried: number; recovered: number }> {
  const accounts = await prisma.gmailAccount.findMany({
    where: {
      status: "REVOKED",
      isActive: true,
      provider: { in: ["GMAIL", "OUTLOOK"] },
      OR: [{ lastErrorAt: null }, { lastErrorAt: { lt: new Date(now.getTime() - RETRY_AFTER_MS) } }],
    },
  });
  let recovered = 0;
  for (const a of accounts) {
    try {
      const refresh = decryptToken(a.refreshToken);
      const r = a.provider === "OUTLOOK" ? await refreshMicrosoft(refresh) : { ...(await refreshGoogle(refresh)), refreshToken: null as string | null };
      await prisma.gmailAccount.update({
        where: { id: a.id },
        data: {
          accessToken: encryptToken(r.accessToken),
          ...(r.refreshToken ? { refreshToken: encryptToken(r.refreshToken) } : {}),
          tokenExpiresAt: new Date(now.getTime() + r.expiresIn * 1000),
          status: "CONNECTED",
          lastError: null,
          lastErrorAt: null,
        },
      });
      recovered++;
      console.log(`[MailRecovery] ${a.emailAddress} works again — reconnected automatically.`);
      emitToCompany(a.companyId, "employee:updated", { employeeId: a.employeeId });
    } catch (e: any) {
      const reason = e?.tokenError?.reason ?? (e instanceof Error ? e.message : String(e));
      await prisma.gmailAccount.update({ where: { id: a.id }, data: { lastError: String(reason).slice(0, 500), lastErrorAt: now } }).catch(() => undefined);
    }
  }
  return { tried: accounts.length, recovered };
}
