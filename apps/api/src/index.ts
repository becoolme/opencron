import { applyOutboundPolicy } from "./outbound";
import type { Env } from "./types";
import { app } from "./app";
import { handleScheduled } from "./scheduler";
import { appShellPath } from "./web-routes";

export { OpenCronTables, OpenCronD1, OpenCronDatabase, OpenCronKV } from "./dynamic-bindings";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Deep links into the app (`/app/jobs/4`) reach the Worker first; the app page routes them in the browser.
    const shell = appShellPath(new URL(request.url).pathname);
    if (shell && env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
      return env.ASSETS.fetch(new Request(new URL(shell, request.url), request));
    }
    applyOutboundPolicy(env);
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    applyOutboundPolicy(env);
    ctx.waitUntil(handleScheduled(env, ctx));
  },
} satisfies ExportedHandler<Env>;
