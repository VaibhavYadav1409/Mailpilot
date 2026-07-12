import { describe, it, expect, vi } from "vitest";

// rbac.ts imports `prisma` from ../src/lib/db at module load time, and db.ts
// imports the generated Prisma client, which only exists after `prisma
// generate` has run. Mocking the db module lets these pure-logic tests run
// in any environment (e.g. CI steps that test before running codegen)
// without needing a real database connection or generated client.
vi.mock("../src/lib/db", () => ({
  prisma: {
    employee: { findUnique: vi.fn() },
  },
}));

const { employeeScopeFilter, canActOnEmployee } = await import("../src/middleware/rbac");
const { prisma } = await import("../src/lib/db");

const baseUser = {
  employeeId: "emp-1",
  companyId: "company-1",
  departmentId: "dept-1",
  role: "EMPLOYEE" as const,
};

describe("employeeScopeFilter", () => {
  it("scopes CEO/COO/ADMIN to the whole company", () => {
    for (const role of ["CEO", "COO", "ADMIN"] as const) {
      expect(employeeScopeFilter({ ...baseUser, role })).toEqual({ companyId: "company-1" });
    }
  });

  it("scopes MANAGER to their department", () => {
    expect(employeeScopeFilter({ ...baseUser, role: "MANAGER" })).toEqual({
      companyId: "company-1",
      departmentId: "dept-1",
    });
  });

  it("scopes a MANAGER with no department to nothing, not company-wide", () => {
    expect(employeeScopeFilter({ ...baseUser, role: "MANAGER", departmentId: null })).toEqual({
      companyId: "company-1",
      id: "__no_match__",
    });
  });

  it("scopes EMPLOYEE to themselves only", () => {
    expect(employeeScopeFilter(baseUser)).toEqual({
      companyId: "company-1",
      id: "emp-1",
    });
  });
});

describe("canActOnEmployee", () => {
  it("lets an EMPLOYEE act only on themselves, without a DB lookup", async () => {
    expect(await canActOnEmployee(baseUser, "emp-1")).toBe(true);
    expect(await canActOnEmployee(baseUser, "someone-else")).toBe(false);
    expect(prisma.employee.findUnique).not.toHaveBeenCalled();
  });

  it("lets a MANAGER act only on targets in their own department", async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValueOnce({
      companyId: "company-1",
      departmentId: "dept-1",
    } as any);
    expect(await canActOnEmployee({ ...baseUser, role: "MANAGER" }, "emp-2")).toBe(true);

    vi.mocked(prisma.employee.findUnique).mockResolvedValueOnce({
      companyId: "company-1",
      departmentId: "dept-2",
    } as any);
    expect(await canActOnEmployee({ ...baseUser, role: "MANAGER" }, "emp-3")).toBe(false);
  });

  it("denies access to a target in a different company regardless of role", async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValueOnce({
      companyId: "other-company",
      departmentId: "dept-1",
    } as any);
    expect(await canActOnEmployee({ ...baseUser, role: "ADMIN" }, "emp-4")).toBe(false);
  });

  it("lets ADMIN/COO/CEO act on any employee in the same company", async () => {
    vi.mocked(prisma.employee.findUnique).mockResolvedValueOnce({
      companyId: "company-1",
      departmentId: "dept-9",
    } as any);
    expect(await canActOnEmployee({ ...baseUser, role: "CEO" }, "emp-5")).toBe(true);
  });
});
