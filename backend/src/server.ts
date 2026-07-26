import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import cookieParser from "cookie-parser";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { authRouter } from "./routes/auth";
import { imapRouter } from "./routes/imap";
import { gmailRouter } from "./routes/gmail";
import { emailsRouter } from "./routes/emails";
import { analyticsRouter } from "./routes/analytics";
import { employeesRouter } from "./routes/employees";
import { departmentsRouter } from "./routes/departments";
import { settingsRouter } from "./routes/settings";
import { notificationsRouter } from "./routes/notifications";
import { reportsRouter } from "./routes/reports";
import { initSockets } from "./sockets";
import { startScheduler } from "./scheduler";

// A single unhandled promise rejection (e.g. the login route's Prisma call
// when the Neon database is briefly unreachable) was taking the WHOLE server
// down with exit status 1 — turning one cold/failed DB connection into a
// crash loop that broke every request. Log and stay alive instead; individual
// requests still fail, but the server survives and recovers on its own once
// the database is reachable again.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] keeping process alive:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] keeping process alive:", err);
});

const app = express();

// Render (like Heroku/Vercel) terminates TLS and proxies requests through an
// internal load balancer. Without this, Express's req.ip — and anything built
// on it, like the login rate limiter below — resolves to the proxy's own
// address for every single request, not the real client's. That means the
// 20-attempts/15-minutes login limiter would either lump every user in the
// company into one shared bucket (one lockout affects everyone) or, with
// express-rate-limit v7's built-in misconfiguration check, throw a
// validation error and 500 the /login route outright. `1` trusts exactly one
// hop (Render's own proxy) and reads the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

app.use(helmet());
app.use(compression());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "25mb" }));

// Login is a natural brute-force target — rate-limit it tighter than the
// general API.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use("/api/auth/login", loginLimiter);

app.use("/api/auth", authRouter);
app.use("/api/auth", imapRouter);
app.use("/api/gmail", gmailRouter);
app.use("/api/emails", emailsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/employees", employeesRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/reports", reportsRouter);
// Phase 8 complete: scheduled analytics rollup, notification rules engine,
// and scheduled report generation are wired in below via startScheduler().

// Catch-all error handler: any route that forwards an error via next(err)
// (or a sync throw) returns a clean 503 instead of a dangling request or a
// crash. Must be registered AFTER all routes.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[express error]", err);
  if (res.headersSent) return;
  res.status(503).json({ error: "Service temporarily unavailable. Please try again in a moment." });
});

// Plain app.listen() previously — now an explicit http.Server so Socket.IO
// (see sockets/index.ts) can attach to the exact same listener rather than
// opening a second port for live updates.
const httpServer = createServer(app);
initSockets(httpServer);

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
httpServer.listen(port, () => {
  console.log(`MailPilot backend listening on :${port}`);
  // Boot diagnostics — lets us confirm from the deploy logs that the memory-
  // hardened build is the one actually running (vs. a stale cached build).
  // heapLimitMB reflects --max-old-space-size; if it doesn't show ~192 the
  // process is NOT running the current start script.
  const v8 = require("node:v8");
  const heapLimitMB = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
  const rssMB = Math.round(process.memoryUsage().rss / 1048576);
  console.log(
    `[boot] build=keep-75-5 heapLimitMB=${heapLimitMB} rssStartMB=${rssMB} ` +
      `syncConcurrency=${process.env.SYNC_MESSAGE_CONCURRENCY ?? 2} ` +
      `initialDays=${process.env.SYNC_INITIAL_DAYS ?? 7}`,
  );
  startScheduler();
});
