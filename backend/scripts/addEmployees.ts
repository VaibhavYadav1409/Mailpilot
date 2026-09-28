/**
 * Creates (or refreshes) employee accounts that sign in with a plain username
 * instead of an email — no mailbox needed, no email is ever sent.
 *
 *   username = the person's name (case-insensitive: "anjali" / "ANJALI" both work)
 *   password = the name exactly as listed below (CAPITALS)
 *   role     = EMPLOYEE → they automatically appear in the MSI Daily Report
 *              as "expected to submit" every day.
 *
 * Usage (from backend/):
 *   npx tsx scripts/addEmployees.ts
 *   npx tsx scripts/addEmployees.ts <companyId>   # only if you have several companies
 *
 * Safe to run more than once: an existing account with the same username just
 * gets its name/password reset and is re-activated if it was suspended.
 */
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db";

// Edit this list to add more people later.
const NAMES = ["ANJALI", "MAMTA", "JOSEPH", "GURMEET", "ASHOK KUMAR"];

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

async function pickCompanyId(): Promise<string> {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  if (companies.length === 1) return companies[0].id;
  const ceo = await prisma.employee.findFirst({ where: { role: "CEO" }, select: { companyId: true } });
  if (companies.length > 1 && !ceo) {
    throw new Error(
      `Found ${companies.length} companies — pass the companyId:\n` +
        companies.map((c) => `  ${c.id}  ${c.name}`).join("\n")
    );
  }
  if (!ceo) throw new Error("No company found in the database.");
  return ceo.companyId;
}

async function nextEmployeeCode(companyId: string): Promise<() => string> {
  const codes = (await prisma.employee.findMany({ where: { companyId }, select: { employeeCode: true } })).map(
    (e) => e.employeeCode
  );
  let prefix = "EMP-";
  let width = 4;
  let max = 0;
  for (const code of codes) {
    const m = /^(.*?)(\d+)$/.exec(code);
    if (!m) continue;
    const n = Number(m[2]);
    if (n >= max) {
      max = n;
      prefix = m[1];
      width = m[2].length;
    }
  }
  const taken = new Set(codes);
  return () => {
    let code: string;
    do code = `${prefix}${String(++max).padStart(width, "0")}`;
    while (taken.has(code));
    taken.add(code);
    return code;
  };
}

async function main() {
  const companyId = await pickCompanyId();
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
  if (!company) throw new Error(`No company with id ${companyId}`);
  console.log(`Company: ${company.name}\n`);
  const nextCode = await nextEmployeeCode(companyId);

  const rows: { Name: string; Username: string; Password: string; Result: string }[] = [];
  for (const raw of NAMES) {
    const name = raw.trim().replace(/\s+/g, " ");
    const username = name.toLowerCase();
    const [first, ...rest] = titleCase(name).split(" ");
    const password = await bcrypt.hash(name, 12);

    const existing = await prisma.employee.findFirst({
      where: { email: { equals: username, mode: "insensitive" } },
      select: { id: true, companyId: true, status: true },
    });

    if (existing) {
      if (existing.companyId !== companyId) {
        rows.push({ Name: titleCase(name), Username: name, Password: name, Result: "SKIPPED — username used in another company" });
        continue;
      }
      await prisma.employee.update({
        where: { id: existing.id },
        data: {
          firstName: first,
          lastName: rest.join(" "),
          password,
          ...(existing.status === "SUSPENDED" ? { status: "OFFLINE" as const } : {}),
        },
      });
      rows.push({ Name: titleCase(name), Username: name, Password: name, Result: "already existed — password reset" });
      continue;
    }

    await prisma.employee.create({
      data: {
        employeeCode: nextCode(),
        email: username,
        password,
        firstName: first,
        lastName: rest.join(" "),
        role: "EMPLOYEE",
        companyId,
        timezone: "Asia/Kolkata",
      },
    });
    rows.push({ Name: titleCase(name), Username: name, Password: name, Result: "created" });
  }

  console.table(rows);
  console.log("\nThey can now sign in on the Employee Portal and will appear in MSI Reports.");
}

main()
  .catch((e) => {
    console.error("Failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
