import { Hono } from "hono";
import type { AppHonoEnv } from "./types";
import { authHandler, sessionAuthMiddleware, signUpAllowed } from "./auth";
import { jobsRouter } from "./routes/jobs";
import { executionsRouter } from "./routes/executions";
import { availableRuntimes } from "./runtimes";

/** The HTTP API, shared by the Worker (index.ts) and the Node server (server.ts). */
export const app = new Hono<AppHonoEnv>();

// Better Auth handles registration, login, logout, and session endpoints.
app.all("/api/auth/*", (c) => authHandler(c.env, c.req.raw));

// Public, before the session check: what the sign-in page may offer.
app.get("/api/instance", async (c) => c.json({ sign_up: await signUpAllowed(c.env) }));

// API group, all protected
const api = new Hono<AppHonoEnv>();
api.use("*", sessionAuthMiddleware);
api.route("/jobs", jobsRouter);
api.route("/executions", executionsRouter);
// What this deployment can do, so the app only offers what will run.
api.get("/meta", (c) => c.json({ runtimes: availableRuntimes(c.env) }));

app.route("/api", api);
