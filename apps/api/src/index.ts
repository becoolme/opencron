import { applyOutboundPolicy } from "./outbound";
import type { Env } from "./types";
import { app } from "./app";
import { handleScheduled } from "./scheduler";

export { OpenCronTables, OpenCronD1, OpenCronDatabase, OpenCronKV } from "./dynamic-bindings";

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
