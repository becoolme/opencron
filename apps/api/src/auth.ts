import { authPool, databaseProvider, getDatabase } from "./database";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { MiddlewareHandler } from "hono";
import { signUpMode } from "./sign-up";
import { presentedApiKey, verifyApiKey } from "./api-keys";
import type { AppHonoEnv, Env } from "./types";
import { createPersonalWorkspace } from "./workspace";

/** The host of APP_URL (where this deployment is served), which sign-in requests may come from besides localhost. */
function appHosts(env: Env): string[] {
  if (!env.APP_URL) return [];
  try {
    return [new URL(env.APP_URL).host];
  } catch {
    throw new Error(`APP_URL is not a URL: ${env.APP_URL}`);
  }
}

/**
 * Whether a new account may be created. With SIGNUP=closed only the first account can sign up, plus anyone holding a
 * pending, unexpired invitation for their email address.
 */
export async function signUpAllowed(env: Env, holder: { email?: string; invitationId?: string } = {}): Promise<boolean> {
  if (signUpMode(env) === "open") return true;
  const db = getDatabase(env);
  if (!(await db.prepare('SELECT 1 AS one FROM "user" LIMIT 1').first())) return true;
  const [column, value] = holder.email ? ["lower(email)", holder.email.toLowerCase()] : ["id", holder.invitationId];
  if (!value) return false;
  return Boolean(await db.prepare(
    `SELECT 1 AS one FROM invitation WHERE ${column} = ? AND status = 'pending' AND "expiresAt" > ?`,
  ).bind(value, new Date().toISOString()).first());
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
          before: async (user) => {
            if (!(await signUpAllowed(env, { email: user.email }))) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is closed on this deployment" });
            }
          },
          after: async (user) => {
            // every account starts with a personal workspace; jobs from before accounts existed move into the first
            await createPersonalWorkspace(env, user);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const first = await db.prepare(
              `SELECT "organizationId" AS id FROM member WHERE "userId" = ? ORDER BY "createdAt", id LIMIT 1`,
            ).bind(session.userId).first<{ id: string }>();
            return { data: { ...session, activeOrganizationId: first?.id ?? null } };
          },
        },
      },
    },
    session: {
      additionalFields: {
        activeOrganizationId: { type: "string", required: false, input: false },
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
    if (user.workspaceId) c.set("apiKeyWorkspaceId", user.workspaceId);
    c.set("apiKeyProjectIds", user.projectIds);
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
  c.set("sessionId", session.session.id);
  await next();
};
