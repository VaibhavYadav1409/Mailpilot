/**
 * Creates (or refreshes) MSI staff accounts from the command line. The admin
 * dashboard's Employees page → "MSI staff" → "Add staff" does the same thing.
 *
 *   username = the person's name (case-insensitive)
 *   password = the name in CAPITALS
 *   role     = EMPLOYEE, no mailbox, no email ever sent
 *
 * Usage (from backend/):
 *   npx tsx scripts/addEmployees.ts                       # the list below
 *   npx tsx scripts/addEmployees.ts "RAHUL" "PRIYA SHARMA" # specific names
 * Set COMPANY_ID=<id> if the database has more than one company.
 * Safe to run again: existing accounts just get their password reset.
 */
import { prisma } from "../src/lib/db";
import { upsertMsiStaff } from "../src/services/msiStaff";

const DEFAULT_NAMES = ["ANJALI", "MAMTA", "JOSEPH", "GURMEET", "ASHOK KUMAR"];

async function pickCompanyId(): Promise<string> {
  if (process.env.COMPANY_ID) return process.env.COMPANY_ID;
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  if (companies.length === 1) return companies[0].id;
  if (companies.length === 0) throw new Error("No company found in the database.");
  throw new Error(
    `Found ${companies.length} companies — set COMPANY_ID to one of:\n` +
      companies.map((c) => `  ${c.id}  ${c.name}`).join("\n")
  );
}

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_NAMES;
  const companyId = await pickCompanyId();
  const rows = [];
  for (const name of names) {
    try {
      const r = await upsertMsiStaff(companyId, name);
      rows.push({ Username: r.username, Password: r.password, Result: r.created ? "created" : "already existed — password reset" });
    } catch (e) {
      rows.push({ Username: name, Password: "", Result: `FAILED — ${e instanceof Error ? e.message : e}` });
    }
  }
  console.table(rows);
}

main()
  .catch((e) => {
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
