/**
 * Rename specific employees (and optionally change an employee's login email),
 * matched by their CURRENT login email. Idempotent and safe to re-run.
 *
 * Edit the UPDATES list below, then run from backend/:
 *   npx tsx scripts/renameEmployees.ts            # dry-run (shows changes)
 *   npx tsx scripts/renameEmployees.ts --confirm  # apply
 *
 * `name` is split on the first space: first word -> firstName, rest -> lastName.
 * `newEmail` (optional) changes the employee's login email (Employee.email);
 * it must not already be used by another employee.
 */
import { prisma } from "../src/lib/db";

const CONFIRM = process.argv.includes("--confirm");

const UPDATES: { match: string; name: string; newEmail?: string }[] = [
  { match: "demat@farsightshares.com",        name: "Demat" },
  { match: "manager.support@acme.com",        name: "NewAccount", newEmail: "newaccount@farsightshares.com" },
  { match: "accounts@farsightshares.com",     name: "Account Mails" },
  { match: "ceo@acme.com",                    name: "CEO" },
];

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? full, lastName: parts.slice(1).join(" ") };
}

async function main() {
  console.log(`Mode: ${CONFIRM ? "APPLY (--confirm)" : "DRY-RUN"}\n`);
  for (const u of UPDATES) {
    const emp = await prisma.employee.findFirst({
      where: { email: { equals: u.match, mode: "insensitive" } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!emp) { console.log(`- SKIP  ${u.match} — no employee with that login email`); continue; }

    const { firstName, lastName } = splitName(u.name);

    // Guard: a new login email must be free.
    if (u.newEmail) {
      const clash = await prisma.employee.findFirst({
        where: { email: { equals: u.newEmail, mode: "insensitive" }, id: { not: emp.id } },
        select: { id: true },
      });
      if (clash) { console.log(`- SKIP  ${u.match} — target email ${u.newEmail} already used by another employee`); continue; }
    }

    const from = `${emp.firstName} ${emp.lastName}`.trim() + ` <${emp.email}>`;
    const to = `${u.name}` + (u.newEmail ? ` <${u.newEmail}>` : ` <${emp.email}>`);
    console.log(`- ${CONFIRM ? "UPDATE" : "would update"}  ${from}  ->  ${to}`);

    if (CONFIRM) {
      await prisma.employee.update({
        where: { id: emp.id },
        data: { firstName, lastName, ...(u.newEmail ? { email: u.newEmail } : {}) },
      });
    }
  }
  console.log(`\n${CONFIRM ? "Done." : "Dry-run only — re-run with --confirm to apply."}`);
}
main().catch((e) => { console.error("renameEmployees failed:", e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
