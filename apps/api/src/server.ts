import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { app } from "./app";
import { migratePostgres } from "./migrate";
import { applyOutboundPolicy } from "./outbound";
import { handleScheduled } from "./scheduler";
import type { AppHonoEnv, Env } from "./types";

/**
 * Self-hosted entry point (Docker): one Node process serving the API, the web build and the scheduler, against
 * PostgreSQL. Script jobs go to the sandbox service (apps/sandbox), which runs each one in its own container.
 */
const vars = process.env;
const need = (key: string): string => {
  const value = vars[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};
// the placeholders from .env.docker.example must never reach a running deployment: they would let anyone forge
// sessions or submit code to the sandbox
for (const key of ["BETTER_AUTH_SECRET", "SANDBOX_TOKEN"]) {
  const value = vars[key];
  if (value && (/^change-me/i.test(value) || value.length < 16)) {
    throw new Error(`${key} is a placeholder or too short: generate one with \`openssl rand -hex 32\``);
  }
}
const port = Number(vars.PORT ?? 8080);

const env: Env = {
  DB_PROVIDER: "postgres",
  DATABASE_URL: need("DATABASE_URL"),
  BETTER_AUTH_SECRET: need("BETTER_AUTH_SECRET"),
  APP_URL: vars.APP_URL || `http://localhost:${port}`,
  ALLOW_PRIVATE_TARGETS: vars.ALLOW_PRIVATE_TARGETS,
  SANDBOX_URL: vars.SANDBOX_URL || undefined,
  SANDBOX_TOKEN: vars.SANDBOX_TOKEN || undefined,
};
if (env.SANDBOX_URL && !env.SANDBOX_TOKEN) throw new Error("SANDBOX_TOKEN is required when SANDBOX_URL is set");
if (!env.SANDBOX_URL) console.warn("SANDBOX_URL is not set: script jobs cannot run on this deployment");
applyOutboundPolicy(env);

await migratePostgres(env.DATABASE_URL!);

const root = new Hono<AppHonoEnv>();
root.get("/health", (c) => c.text("ok"));
root.route("/", app);

// The web build, with the headers Cloudflare would apply from its _headers file.
const webDist = resolve(vars.WEB_DIST ?? join(import.meta.dirname, "../../web/dist/client"));
if (existsSync(join(webDist, "index.html"))) {
  const rules = parseHeadersFile(join(webDist, "_headers"));
  root.use("*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api/")) return;
    for (const [pattern, headers] of rules) {
      if (!matches(pattern, c.req.path)) continue;
      for (const [name, value] of headers) c.res.headers.set(name, value);
    }
  });
  root.use("*", serveStatic({ root: webDist }));
  const indexHtml = readFileSync(join(webDist, "index.html"), "utf8");
  root.get("*", (c) => c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.html(indexHtml));
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

function parseHeadersFile(path: string): Array<[string, Array<[string, string]>]> {
  if (!existsSync(path)) return [];
  const rules: Array<[string, Array<[string, string]>]> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { rules.push([line.trim(), []]); continue; }
    const colon = line.indexOf(":");
    if (colon > 0 && rules.length) rules[rules.length - 1][1].push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}
