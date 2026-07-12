import { PrismaClient } from "../generated/prisma/client";

// Singleton pattern — avoids exhausting Postgres connections from hot-reload
// in dev, where the module would otherwise re-instantiate PrismaClient on
// every file change.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
