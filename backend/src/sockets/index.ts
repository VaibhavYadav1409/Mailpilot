import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { verifyAccessToken } from "../lib/jwt";

let io: Server | null = null;

function companyRoom(companyId: string) {
  return `company:${companyId}`;
}

/**
 * Wires Socket.IO onto the same HTTP server Express is already listening on
 * (see server.ts). Auth uses the identical short-lived access token the REST
 * API uses — passed once at connect time via `socket.handshake.auth.token`,
 * not as a query string, so it doesn't end up logged in access logs/proxies.
 * A socket that fails auth is disconnected immediately rather than allowed
 * to sit around unauthenticated.
 */
export function initSockets(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN?.split(",") ?? true, credentials: true },
  });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") {
      return next(new Error("Missing auth token"));
    }
    try {
      socket.data.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error("Invalid or expired auth token"));
    }
  });

  io.on("connection", (socket) => {
    const { companyId } = socket.data.user;
    socket.join(companyRoom(companyId));

    socket.on("disconnect", () => {
      // Room membership is cleaned up automatically by socket.io on disconnect.
    });
  });

  return io;
}

/**
 * Pushes a live update to every connected dashboard for one company. Safe to
 * call before initSockets() has run (e.g. during tests or scripts) — it's a
 * no-op rather than a crash, since none of these events are load-bearing for
 * correctness, only for "the UI updates without a manual refresh."
 */
export function emitToCompany(companyId: string, event: string, payload: unknown) {
  io?.to(companyRoom(companyId)).emit(event, payload);
}
