import { Hono } from "hono";
import type { AppHonoEnv } from "./types";
import { authHandler, sessionAuthMiddleware, signUpAllowed } from "./auth";
import { jobsRouter } from "./routes/jobs";
import { executionsRouter } from "./routes/executions";
import { secretsRouter } from "./routes/secrets";
import { keysRouter } from "./routes/keys";
import { channelsRouter } from "./routes/channels";
import { inviteRouter, invitationsRouter, membersRouter, projectsRouter, workspacesRouter } from "./routes/workspaces";
import { workspaceMiddleware } from "./workspace";
import { availableRuntimes } from "./runtimes";
import { mountOpenCronMcp } from "./mcp";
import { community, type Edition } from "./edition";
import { usage } from "./usage";

/**
 * The HTTP API, shared by the Worker (index.ts) and the Node server (server.ts). `edition` decides the plans and their
 * limits; the open-source edition has none.
 */
export function createApp(edition: Edition = community): Hono<AppHonoEnv> {
  const app = new Hono<AppHonoEnv>();
  app.use("*", async (c, next) => {
    c.set("edition", edition);
    await next();
  });

  // Better Auth handles registration, login, logout, and session endpoints.
  app.all("/api/auth/*", (c) => authHandler(c.env, c.req.raw));

  // Public, before the session check: what the sign-in page may offer. `invite` names the invitation link someone
  // followed, which lets its holder sign up even when sign-up is closed.
  app.get("/api/instance", async (c) => c.json({ sign_up: await signUpAllowed(c.env, { invitationId: c.req.query("invite") }) }));

  // MCP endpoint: each tool call is dispatched back into this app with the caller's own credentials.
  mountOpenCronMcp(app);

  // API group, all protected
  const api = new Hono<AppHonoEnv>();
  api.use("*", sessionAuthMiddleware);
  // An invitation is opened by someone who is not a member yet, so it sits outside the workspace scope.
  api.route("/invite", inviteRouter);
  api.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/invite/")) return next();
    return workspaceMiddleware(c, next);
  });
  api.route("/workspaces", workspacesRouter);
  api.route("/projects", projectsRouter);
  api.route("/members", membersRouter);
  api.route("/invitations", invitationsRouter);
  api.route("/jobs", jobsRouter);
  api.route("/executions", executionsRouter);
  api.route("/secrets", secretsRouter);
  api.route("/keys", keysRouter);
  api.route("/channels", channelsRouter);
  // What this deployment can do, so the app only offers what will run.
  api.get("/meta", (c) => c.json({ runtimes: availableRuntimes(c.env) }));
  // The workspace's plan and how much of it is used.
  api.get("/usage", async (c) => c.json(await usage(c)));

  edition.mount?.({ app, api });
  app.route("/api", api);
  return app;
}

export const app = createApp();
