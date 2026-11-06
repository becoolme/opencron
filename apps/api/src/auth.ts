import { authPool, databaseProvider, getDatabase } from "./database";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { MiddlewareHandler } from "hono";
import { signUpMode } from "./sign-up";
import { presentedApiKey, verifyApiKey } from "./api-keys";
import type { AppHonoEnv, Env } from "./types";

/** The host of APP_URL (where this deployment is served), which sign-in requests may come from besides localhost. */
function appHosts(env: Env): string[] {
  if (!env.APP_URL) return [];
  try {
    return [new URL(env.APP_URL).host];
  } catch {
    throw new Error(`APP_URL is not a URL: ${env.APP_URL}`);
  }
}

export async function signUpAllowed(env: Env): Promise<boolean> {
  if (signUpMode(env) === "open") return true;
  return !(await getDatabase(env).prepare('SELECT 1 AS one FROM "user" LIMIT 1').first());
}

export function createAuth(env: Env) {
  const db = getDatabase(env);
  const pool = databaseProvider(env) === "postgres" ? authPool(env) : undefined;
  const auth = betterAuth({
    appName: "OpenCron",
    database: pool ?? env.DB!,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: {
      allowedHosts: [...appHosts(env), "localhost:*", "127.0.0.1:*"],
      protocol: "auto",
      fallback: env.APP_URL || "http://localhost:5173",
    },
    emailAndPassword: {
      enabled: true,
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (!(await signUpAllowed(env))) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is closed on this deployment" });
            }
          },
          after: async (user) => {
            // Preserve pre-authentication jobs by assigning them to the first
            // user created after this migration.
            await db.prepare(
              "UPDATE jobs SET owner_user_id = ? WHERE owner_user_id IS NULL",
            ).bind(user.id).run();
          },
        },
      },
    },
    telemetry: {
      enabled: false,
    },
  });
  return { auth, close: async () => { await pool?.end(); } };
}

export async function authHandler(env: Env, request: Request): Promise<Response> {
  const { auth, close } = createAuth(env);
  try { return await auth.handler(request); } finally { await close(); }
}

/**
 * Signs the caller in with an API key (`Authorization: Bearer oc_…` or `x-api-key`) or else the browser session.
 * A read key may only read: anything but GET and HEAD is refused with 403.
 */
export const sessionAuthMiddleware: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  const token = presentedApiKey(c.req.raw.headers);
  if (token) {
    const user = await verifyApiKey(c.env, token);
    if (!user) return c.json({ error: "Invalid API key" }, 401);
    if (user.scope === "read" && c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: "This API key is read-only" }, 403);
    }
    c.set("userId", user.userId);
    c.set("userName", user.name);
    c.set("userEmail", user.email);
    c.set("authMethod", "api_key");
    c.set("apiKeyScope", user.scope);
    return next();
  }

  const { auth, close } = createAuth(c.env);
  const session = await (async () => {
    try { return await auth.api.getSession({ headers: c.req.raw.headers }); }
    finally { await close(); }
  })();

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userId", session.user.id);
  c.set("userName", session.user.name);
  c.set("userEmail", session.user.email);
  c.set("authMethod", "session");
  await next();
};
