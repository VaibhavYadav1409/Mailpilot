/**
 * Remove an employee from MailPilot for good — someone who has left.
 *
 * Deletes the person and everything that belongs only to them: their
 * mailbox(es) with every synced email, attachment, category and reply, AI
 * actions, sessions, daily analytics, daily reports (with their files), MIS
 * files / checks / evidence / circle marks / email log, and leave records.
 * Audit log rows they made are kept but unlinked (employeeId = null), and a
 * department they managed loses its manager. One EMPLOYEE_REMOVED audit row
 * records who removed whom.
 *
 * This cannot be undone. Suspending is the reversible alternative.
 */
import { prisma } from "../lib/db";
import { deleteAttachment } from "../lib/attachmentStorage";
import { deleteMsiFiles } from "../lib/msiStorage";
import { ROLE_RANK, type Role } from "../../../shared/const";

export class EmployeeRemovalError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface RemovalResult {
  name: string;
  email: string;
  emails: number;
  reports: number;
  misFiles: number;
}

export async function removeEmployee(
  actor: { companyId: string; employeeId: string; role: Role },
  employeeId: string,
): Promise<RemovalResult> {
  if (employeeId === actor.employeeId) throw new EmployeeRemovalError(400, "You can't remove your own account.");
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, companyId: actor.companyId },
    select: { id: true, firstName: true, lastName: true, email: true, role: true, gmailAccounts: { select: { id: true } } },
  });
  if (!e) throw new EmployeeRemovalError(404, "Employee not found.");
  if (ROLE_RANK[e.role as Role] > ROLE_RANK[actor.role]) throw new EmployeeRemovalError(403, "You can't remove someone with a higher role than yours.");

  const name = `${e.firstName} ${e.lastName}`.trim();
  const accountIds = e.gmailAccounts.map((g) => g.id);
  const emailIds = accountIds.length
    ? (await prisma.email.findMany({ where: { gmailAccountId: { in: accountIds } }, select: { id: true } })).map((m) => m.id)
    : [];
  const blobKeys = emailIds.length
    ? (await prisma.attachment.findMany({ where: { emailId: { in: emailIds } }, select: { storageKey: true } })).map((b) => b.storageKey)
    : [];
  const reports = await prisma.msiDailyReport.findMany({ where: { employeeId: e.id }, select: { storageReference: true } });
  const misFiles = await prisma.misSource.count({ where: { employeeId: e.id } });

  await prisma.$transaction(
    async (tx) => {
      // Mail
      if (emailIds.length) {
        for (let i = 0; i < emailIds.length; i += 5000) {
          const chunk = emailIds.slice(i, i + 5000);
          await tx.attachment.deleteMany({ where: { emailId: { in: chunk } } });
          await tx.emailCategory.deleteMany({ where: { emailId: { in: chunk } } });
          await tx.reply.deleteMany({ where: { emailId: { in: chunk } } });
          await tx.aIAction.updateMany({ where: { emailId: { in: chunk } }, data: { emailId: null } });
        }
        await tx.email.deleteMany({ where: { gmailAccountId: { in: accountIds } } });
      }
      if (accountIds.length) await tx.gmailAccount.deleteMany({ where: { employeeId: e.id } });
      await tx.reply.deleteMany({ where: { employeeId: e.id } });
      await tx.aIAction.deleteMany({ where: { employeeId: e.id } });
      await tx.session.deleteMany({ where: { employeeId: e.id } });
      await tx.dailyAnalytics.deleteMany({ where: { employeeId: e.id } });
      // Daily reports + MIS
      await tx.msiDailyReport.deleteMany({ where: { employeeId: e.id } });
      await tx.misCheckEvent.deleteMany({ where: { employeeId: e.id } });
      await tx.misDailyCheck.deleteMany({ where: { employeeId: e.id } });
      await tx.misSource.deleteMany({ where: { employeeId: e.id } });
      await tx.misCircleMark.deleteMany({ where: { employeeId: e.id } });
      await tx.misEmailLog.deleteMany({ where: { employeeId: e.id } });
      await tx.misLeave.deleteMany({ where: { employeeId: e.id } });
      // Keep the history, unlinked
      await tx.auditLog.updateMany({ where: { employeeId: e.id }, data: { employeeId: null } });
      await tx.department.updateMany({ where: { managerId: e.id }, data: { managerId: null } });
      await tx.employee.delete({ where: { id: e.id } });
      await tx.auditLog.create({
        data: {
          companyId: actor.companyId,
          employeeId: actor.employeeId,
          action: "EMPLOYEE_REMOVED",
          metadata: { removedEmployeeId: e.id, name, email: e.email, role: e.role, emails: emailIds.length, reports: reports.length, misFiles },
        },
      });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  // Stored files, best effort (rows are already gone).
  for (const k of blobKeys) await deleteAttachment(k).catch(() => undefined);
  if (reports.length) await deleteMsiFiles(reports.map((r) => r.storageReference)).catch(() => undefined);

  return { name, email: e.email, emails: emailIds.length, reports: reports.length, misFiles };
}
