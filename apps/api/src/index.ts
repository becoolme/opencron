import { applyOutboundPolicy } from "./outbound";
import { Hono } from "hono";
import type { AppHonoEnv, Env } from "./types";
import { authHandler, sessionAuthMiddleware } from "./auth";
import { jobsRouter } from "./routes/jobs";
import { executionsRouter } from "./routes/executions";
import { handleScheduled } from "./scheduler";

export { OpenCronTables, OpenCronD1, OpenCronDatabase, OpenCronKV } from "./dynamic-bindings";

const app = new Hono<AppHonoEnv>();

// Better Auth handles registration, login, logout, and session endpoints.
app.all("/api/auth/*", (c) => authHandler(c.env, c.req.raw));

// API group, all protected
const api = new Hono<AppHonoEnv>();
api.use("*", sessionAuthMiddleware);
api.route("/jobs", jobsRouter);
api.route("/executions", executionsRouter);

app.route("/api", api);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    applyOutboundPolicy(env);
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    applyOutboundPolicy(env);
    ctx.waitUntil(handleScheduled(env, ctx));
  },
} satisfies ExportedHandler<Env>;
