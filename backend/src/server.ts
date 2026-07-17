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

// Plain app.listen() previously — now an explicit http.Server so Socket.IO
// (see sockets/index.ts) can attach to the exact same listener rather than
// opening a second port for live updates.
const httpServer = createServer(app);
initSockets(httpServer);

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
httpServer.listen(port, () => {
  console.log(`MailPilot backend listening on :${port}`);
  startScheduler();
});
