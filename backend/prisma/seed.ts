import { PrismaClient } from "../src/generated/prisma";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("ChangeMe123!", 12);

  const company = await prisma.company.create({
    data: {
      name: "Acme Corp",
      status: "ACTIVE",
      settings: {
        create: {
          businessHoursStart: "09:00",
          businessHoursEnd: "17:00",
          performanceThreshold: 70.0,
        },
      },
    },
  });

  const support = await prisma.department.create({
    data: { name: "Support", companyId: company.id },
  });
  const sales = await prisma.department.create({
    data: { name: "Sales", companyId: company.id },
  });

  const ceo = await prisma.employee.create({
    data: {
      employeeCode: "EMP-0001",
      email: "ceo@acme.com",
      password: passwordHash,
      firstName: "Casey",
      lastName: "Owens",
      role: "CEO",
      companyId: company.id,
    },
  });

  const supportManager = await prisma.employee.create({
    data: {
      employeeCode: "EMP-0002",
      email: "manager.support@acme.com",
      password: passwordHash,
      firstName: "Morgan",
      lastName: "Lee",
      role: "MANAGER",
      companyId: company.id,
      departmentId: support.id,
    },
  });

  await prisma.department.update({
    where: { id: support.id },
    data: { managerId: supportManager.id },
  });

  await prisma.employee.create({
    data: {
      employeeCode: "EMP-0003",
      email: "agent1@acme.com",
      password: passwordHash,
      firstName: "Riley",
      lastName: "Chen",
      role: "EMPLOYEE",
      companyId: company.id,
      departmentId: support.id,
    },
  });

  await prisma.employee.create({
    data: {
      employeeCode: "EMP-0004",
      email: "sales1@acme.com",
      password: passwordHash,
      firstName: "Jordan",
      lastName: "Patel",
      role: "EMPLOYEE",
      companyId: company.id,
      departmentId: sales.id,
    },
  });

  console.log("Seeded company:", company.name);
  console.log("Demo login (all roles): password = ChangeMe123!");
  console.log("  ceo@acme.com (CEO)");
  console.log("  manager.support@acme.com (MANAGER, Support)");
  console.log("  agent1@acme.com (EMPLOYEE, Support)");
  console.log("  sales1@acme.com (EMPLOYEE, Sales)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
