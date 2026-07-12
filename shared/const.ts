export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
export const FORBIDDEN_ERR_MSG = 'You do not have required permission (10003)';

// Mirrors the Prisma `Role` enum (backend/prisma/schema.prisma). Duplicated
// here (rather than imported from the generated Prisma client) so frontend
// packages that never install @prisma/client can still use it.
export type Role = "CEO" | "COO" | "ADMIN" | "MANAGER" | "EMPLOYEE";

// Higher number = more senior. Used to check "can user A act on/assign role B".
export const ROLE_RANK: Record<Role, number> = {
  CEO: 5,
  COO: 4,
  ADMIN: 3,
  MANAGER: 2,
  EMPLOYEE: 1,
};

// jsonwebtoken `expiresIn` value for access tokens.
export const JWT_ACCESS_EXPIRES_IN = "15m";
// Refresh token session lifetime, in milliseconds.
export const REFRESH_TOKEN_EXPIRES_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
