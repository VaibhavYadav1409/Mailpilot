/**
 * Bulk-links MIS spreadsheets from a JSON file — the same thing as
 * Employees → MIS staff → "Import list" in the admin site.
 *
 * Usage (from backend/):
 *   npx tsx scripts/importMis.ts scripts/mis-import.local.json
 * Set COMPANY_ID=<id> if the database has more than one company.
 *
 * The file is a list of { name, url, checkedBy?, approvedBy?, username? }.
 * `username` attaches the file to an existing MIS staff login (e.g. "anjali");
 * without it a login is created from the name (password = NAME in capitals).
 * Keep these files out of git (*.local.json is ignored): they hold internal links.
 * Safe to run again — files already linked are only updated.
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { importMisRows, type MisImportRow } from "../src/services/misService";

async function companyId(): Promise<string> {
  if (process.env.COMPANY_ID) return process.env.COMPANY_ID;
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  if (companies.length === 1) return companies[0].id;
  // Several companies: use the one the MIS staff already belong to.
  const staff = await prisma.employee.findFirst({ where: { NOT: { email: { contains: "@" } } }, select: { companyId: true } });
  if (staff) return staff.companyId;
  throw new Error(`Set COMPANY_ID to one of:\n${companies.map((c) => `  ${c.id}  ${c.name}`).join("\n")}`);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npx tsx scripts/importMis.ts <file.json>");
  const rows = JSON.parse(readFileSync(file, "utf8")) as MisImportRow[];
  const results = await importMisRows(await companyId(), rows, { runChecks: false });
  console.table(results.map((r) => ({ Name: r.name, Username: r.username ?? "", Result: r.result, Detail: r.detail })));
  console.log("\nNew logins: username = name, password = name in CAPITALS. MailPilot reads the files within 10 minutes.");
}

main()
  .catch((e) => {
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
