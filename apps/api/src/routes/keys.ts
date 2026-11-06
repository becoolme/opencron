import { Hono } from "hono";
import { MAX_API_KEYS, MAX_KEY_NAME_LENGTH, createApiKey, listApiKeys, type ApiKeyScope } from "../api-keys";
import { getDatabase } from "../database";
import type { AppHonoEnv } from "../types";

/** API keys of the signed-in account. Managed from a browser session only: a key cannot mint or revoke keys. */
export const keysRouter = new Hono<AppHonoEnv>();

keysRouter.use("*", async (c, next) => {
  if (c.get("authMethod") !== "session") return c.json({ error: "API keys are managed from the app, not with an API key" }, 403);
  await next();
});

keysRouter.get("/", async (c) => c.json({ keys: await listApiKeys(c.env, c.get("userId")) }));

keysRouter.post("/", async (c) => {
  const owner = c.get("userId");
  const input = await c.req.json().catch(() => null) as { name?: unknown; scope?: unknown } | null;
  if (!input || typeof input !== "object") return c.json({ error: "Expected a JSON object" }, 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > MAX_KEY_NAME_LENGTH) return c.json({ error: `name is at most ${MAX_KEY_NAME_LENGTH} characters` }, 400);
  const scope = input.scope ?? "read";
  if (scope !== "read" && scope !== "write") return c.json({ error: "scope must be 'read' or 'write'" }, 400);

  const count = await getDatabase(c.env).prepare("SELECT COUNT(*) AS n FROM api_keys WHERE owner_user_id = ?")
    .bind(owner).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_API_KEYS) return c.json({ error: `An account holds at most ${MAX_API_KEYS} API keys` }, 400);

  return c.json(await createApiKey(c.env, owner, name, scope as ApiKeyScope), 201);
});

keysRouter.delete("/:id", async (c) => {
  const db = getDatabase(c.env);
  const existing = await db.prepare("SELECT id FROM api_keys WHERE id = ? AND owner_user_id = ?")
    .bind(c.req.param("id"), c.get("userId")).first<{ id: string }>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(existing.id).run();
  return c.body(null, 204);
});
