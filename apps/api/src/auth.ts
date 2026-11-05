import { authPool, databaseProvider, getDatabase } from "./database";
import { betterAuth } from "better-auth";
import type { MiddlewareHandler } from "hono";
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

export const sessionAuthMiddleware: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
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
  await next();
};
