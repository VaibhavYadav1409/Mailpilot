/**
 * MSI staff = people who only file the MSI Daily Work Report. They have no
 * mailbox and no email address: they sign in with their name as username
 * (stored lowercase in Employee.email, matched case-insensitively) and their
 * name in CAPITALS as password. Mail employees always have a real email
 * login, so the "@" is what tells the two groups apart everywhere.
 */
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db";

/** True for a username-only login (MSI staff), false for an email login (mail employee). */
export function isMsiStaffLogin(login: string): boolean {
  return !login.includes("@");
}

/** Prisma `where` fragment that keeps only mail employees (email logins). */
export const MAIL_EMPLOYEE_WHERE = { email: { contains: "@" } } as const;

export class MsiStaffError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Normalises what an admin typed into the canonical display name, e.g. "  ashok   KUMAR " -> "ASHOK KUMAR". */
export function normaliseStaffName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ").toUpperCase();
  if (!name || name.length > 60 || !/^[A-Z][A-Z .'-]*$/.test(name)) {
    throw new MsiStaffError(400, "Use letters and spaces only (max 60 characters).");
  }
  return name;
}

async function nextEmployeeCode(companyId: string): Promise<string> {
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
  let code: string;
  do code = `${prefix}${String(++max).padStart(width, "0")}`;
  while (taken.has(code));
  return code;
}

/**
 * Creates an MSI staff account, or — if that username already exists in the
 * company — resets its password back to the name and re-activates it.
 * Username = name (any case), password = name in CAPITALS. Never sends mail.
 */
export async function upsertMsiStaff(companyId: string, rawName: string, opts: { keepPassword?: boolean } = {}) {
  const name = normaliseStaffName(rawName);
  const username = name.toLowerCase();
  const [firstName, ...rest] = titleCase(name).split(" ");
  const lastName = rest.join(" ");
  const password = await bcrypt.hash(name, 12);

  const existing = await prisma.employee.findFirst({
    where: { email: { equals: username, mode: "insensitive" } },
    select: { id: true, companyId: true, status: true },
  });

  if (existing) {
    if (existing.companyId !== companyId) {
      throw new MsiStaffError(409, "That username is already taken.");
    }
    if (opts.keepPassword) {
      // Bulk import: an existing person is just matched, never reset.
      const employee = await prisma.employee.findUniqueOrThrow({
        where: { id: existing.id },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      return { employee, created: false, username: name, password: name };
    }
    const employee = await prisma.employee.update({
      where: { id: existing.id },
      data: {
        firstName,
        lastName,
        password,
        ...(existing.status === "SUSPENDED" ? { status: "OFFLINE" as const } : {}),
      },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    return { employee, created: false, username: name, password: name };
  }

  const employee = await prisma.employee.create({
    data: {
      employeeCode: await nextEmployeeCode(companyId),
      email: username,
      password,
      firstName,
      lastName,
      role: "EMPLOYEE",
      companyId,
      timezone: "Asia/Kolkata",
    },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  return { employee, created: true, username: name, password: name };
}
