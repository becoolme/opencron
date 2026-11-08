import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { app } from "./app";
import { migratePostgres } from "./migrate";
import { nodeConfig } from "./node-config";
import { applyOutboundPolicy } from "./outbound";
import { handleScheduled } from "./scheduler";
import { headersFor, parseHeaders } from "./static-headers";
import type { AppHonoEnv } from "./types";
import { pageFile } from "./web-routes";

/**
 * Self-hosted entry point (Docker): one Node process serving the API, the web build and the scheduler, against
 * PostgreSQL. Script jobs go to the sandbox service (apps/sandbox), which runs each one in its own container.
 */
const { env, port, warnings } = nodeConfig(process.env);
for (const warning of warnings) console.warn(warning);
applyOutboundPolicy(env);

await migratePostgres(env.DATABASE_URL!);

const root = new Hono<AppHonoEnv>();
root.get("/health", (c) => c.text("ok"));
root.route("/", app);

// The web build, with the headers Cloudflare would apply from its _headers file.
const webDist = resolve(process.env.WEB_DIST ?? join(import.meta.dirname, "../../web/dist"));
if (existsSync(join(webDist, "index.html"))) {
  const headersFile = join(webDist, "_headers");
  const rules = existsSync(headersFile) ? parseHeaders(readFileSync(headersFile, "utf8")) : [];
  root.use("*", async (c, next) => {
    await next();
    for (const [name, value] of headersFor(rules, c.req.path)) c.res.headers.set(name, value);
  });
  root.use("*", serveStatic({ root: webDist }));
  // Pages are `<path>.html` files, as Cloudflare serves them; app deep links get the app page, anything else 404.html.
  const notFound = existsSync(join(webDist, "404.html")) ? readFileSync(join(webDist, "404.html"), "utf8") : "Not found";
  root.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    const file = pageFile(c.req.path);
    if (file && existsSync(join(webDist, file))) return c.html(readFileSync(join(webDist, file), "utf8"));
    return c.html(notFound, 404);
  });
} else {
  console.warn(`No web build at ${webDist}: serving the API only`);
}

serve({ fetch: (request) => root.fetch(request, env), port }, () => console.log(`OpenCron listening on :${port}`));

// The scheduler: once a minute, on the minute, like the Cloudflare cron trigger.
function tick() {
  handleScheduled(env).catch((error) => console.error("scheduler:", error));
}
setTimeout(() => {
  tick();
  setInterval(tick, 60_000);
}, 60_000 - (Date.now() % 60_000));
