import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/db";
import { ROLE_RANK, FORBIDDEN_ERR_MSG, type Role } from "../../../shared/const";

/** Middleware factory: rejects unless the caller's role rank >= minRole's rank.
 *  Must run after requireAuth. */
export function requireMinRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: FORBIDDEN_ERR_MSG });
    }
    next();
  };
}

/**
 * Returns a Prisma `where` fragment scoping any Employee-rooted query to what
 * the caller is allowed to see:
 *   - CEO / COO / ADMIN: entire company
 *   - MANAGER: only their own department
 *   - EMPLOYEE: only themselves
 *
 * Every list/report endpoint should spread this into its query instead of
 * trusting a companyId/departmentId passed in the request.
 */
export function employeeScopeFilter(user: { employeeId: string; companyId: string; departmentId: string | null; role: Role }) {
  const base = { companyId: user.companyId };

  if (user.role === "CEO" || user.role === "COO" || user.role === "ADMIN") {
    return base;
  }
  if (user.role === "MANAGER") {
    if (!user.departmentId) {
      // A manager with no department assigned sees nothing rather than
      // accidentally falling through to company-wide access.
      return { ...base, id: "__no_match__" };
    }
    return { ...base, departmentId: user.departmentId };
  }
  // EMPLOYEE
  return { ...base, id: user.employeeId };
}

/**
 * Checks whether the caller may act on a specific target employee (e.g. for
 * suspend/reset-password/assign-role actions), by loading the target's
 * companyId/departmentId and applying the same rules as employeeScopeFilter.
 */
export async function canActOnEmployee(
  user: { employeeId: string; companyId: string; departmentId: string | null; role: Role },
  targetEmployeeId: string
): Promise<boolean> {
  if (user.role === "EMPLOYEE") {
    return targetEmployeeId === user.employeeId;
  }

  const target = await prisma.employee.findUnique({
    where: { id: targetEmployeeId },
    select: { companyId: true, departmentId: true },
  });
  if (!target || target.companyId !== user.companyId) return false;

  if (user.role === "MANAGER") {
    return target.departmentId !== null && target.departmentId === user.departmentId;
  }
  // ADMIN / COO / CEO: full company access
  return true;
}
