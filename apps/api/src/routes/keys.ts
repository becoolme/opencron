import { Hono } from "hono";
import { MAX_API_KEYS, MAX_KEY_NAME_LENGTH, createApiKey, listApiKeys, type ApiKeyScope } from "../api-keys";
import { getDatabase } from "../database";
import type { AppHonoEnv } from "../types";
import { listProjects, requireManager } from "../workspace";

/**
 * API keys of the current workspace. Owners and admins manage them from a browser session only: a key cannot mint or
 * revoke keys. A key acts as the account that created it, in this workspace, and only while that account is a member.
 */
export const keysRouter = new Hono<AppHonoEnv>();

keysRouter.use("*", async (c, next) => {
  if (c.get("authMethod") !== "session") return c.json({ error: "API keys are managed from the app, not with an API key" }, 403);
  await next();
});
keysRouter.use("*", requireManager);

keysRouter.get("/", async (c) => c.json({ keys: await listApiKeys(c.env, c.get("workspaceId")) }));

keysRouter.post("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  const input = await c.req.json().catch(() => null) as { name?: unknown; scope?: unknown; project_ids?: unknown } | null;
  if (!input || typeof input !== "object") return c.json({ error: "Expected a JSON object" }, 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > MAX_KEY_NAME_LENGTH) return c.json({ error: `name is at most ${MAX_KEY_NAME_LENGTH} characters` }, 400);
  const scope = input.scope ?? "read";
  if (scope !== "read" && scope !== "write") return c.json({ error: "scope must be 'read' or 'write'" }, 400);

  let projectIds: string[] | null = null;
  if (input.project_ids !== undefined && input.project_ids !== null) {
    if (!Array.isArray(input.project_ids) || input.project_ids.some((id) => typeof id !== "string")) {
      return c.json({ error: "project_ids must be an array of project ids" }, 400);
    }
    const known = new Set((await listProjects(c.env, workspaceId)).map((project) => project.id));
    const unknown = (input.project_ids as string[]).find((id) => !known.has(id));
    if (unknown) return c.json({ error: `${unknown} is not a project of this workspace` }, 400);
    projectIds = [...new Set(input.project_ids as string[])];
  }

  const count = await getDatabase(c.env).prepare("SELECT COUNT(*) AS n FROM api_keys WHERE organization_id = ?")
    .bind(workspaceId).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_API_KEYS) return c.json({ error: `A workspace holds at most ${MAX_API_KEYS} API keys` }, 400);

  const owner = { id: c.get("userId"), name: c.get("userName") };
  return c.json(await createApiKey(c.env, owner, workspaceId, name, scope as ApiKeyScope, projectIds), 201);
});

keysRouter.delete("/:id", async (c) => {
  const db = getDatabase(c.env);
  const existing = await db.prepare("SELECT id FROM api_keys WHERE id = ? AND organization_id = ?")
    .bind(c.req.param("id"), c.get("workspaceId")).first<{ id: string }>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(existing.id).run();
  return c.body(null, 204);
});
