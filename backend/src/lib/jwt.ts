import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { prisma } from "./db";
import { JWT_ACCESS_EXPIRES_IN, REFRESH_TOKEN_EXPIRES_MS, type Role } from "../../../shared/const";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Fail fast — a missing secret must never silently fall back to a
  // hardcoded default in a multi-tenant system.
  throw new Error("JWT_SECRET env var is required");
}

export interface AccessTokenPayload {
  employeeId: string;
  companyId: string;
  departmentId: string | null;
  role: Role;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET as string, { expiresIn: JWT_ACCESS_EXPIRES_IN });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, JWT_SECRET as string) as AccessTokenPayload;
}

/** Issues a new refresh token, storing it (hashed lookup key = the token itself, since it's random and single-use) in Session. */
export async function issueRefreshToken(employeeId: string): Promise<string> {
  const token = nanoid(64);
  await prisma.session.create({
    data: {
      employeeId,
      refreshToken: token,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRES_MS),
    },
  });
  return token;
}

/** Validates a refresh token against the Session table, rotating it (delete old, issue new) to limit replay window. */
export async function rotateRefreshToken(oldToken: string) {
  const session = await prisma.session.findUnique({ where: { refreshToken: oldToken } });
  if (!session || session.expiresAt < new Date()) {
    return null;
  }
  await prisma.session.delete({ where: { id: session.id } });
  const newToken = await issueRefreshToken(session.employeeId);
  return { employeeId: session.employeeId, refreshToken: newToken };
}

export async function revokeRefreshToken(token: string) {
  await prisma.session.deleteMany({ where: { refreshToken: token } });
}
