import { Hono } from "hono";
import { getDatabase } from "../database";
import {
  MAX_NOTE_LENGTH, MAX_SECRETS, MAX_SECRET_BYTES, MAX_TOTAL_SECRET_BYTES,
  encryptSecret, listSecrets, secretNameProblem, secretsForRun,
} from "../secrets";
import type { AppHonoEnv } from "../types";
import { requireManager } from "../workspace";

/**
 * Secrets of the current workspace. Every member sees their names; owners and admins change them. Values go in and
 * never come back out (scripts, which members may edit, do read them at run time).
 */
export const secretsRouter = new Hono<AppHonoEnv>();

secretsRouter.get("/", async (c) => c.json({ secrets: await listSecrets(c.env, c.get("workspaceId")) }));

secretsRouter.put("/:name", requireManager, async (c) => {
  const workspaceId = c.get("workspaceId");
  // the account saving a value seals it
  const owner = c.get("userId");
  const name = c.req.param("name");
  const problem = secretNameProblem(name);
  if (problem) return c.json({ error: problem }, 400);

  const input = await c.req.json().catch(() => null) as { value?: unknown; note?: unknown } | null;
  if (!input || typeof input !== "object") return c.json({ error: "Expected a JSON object" }, 400);
  if (input.value !== undefined && typeof input.value !== "string") return c.json({ error: "value must be a string" }, 400);
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") return c.json({ error: "note must be a string" }, 400);

  const db = getDatabase(c.env);
  const existing = await db.prepare("SELECT id, note FROM secrets WHERE organization_id = ? AND name = ?")
    .bind(workspaceId, name).first<{ id: number; note: string | null }>();
  // an omitted note keeps the one saved; null or "" clears it
  const note = input.note === undefined
    ? existing?.note ?? null
    : typeof input.note === "string" ? input.note.trim().slice(0, MAX_NOTE_LENGTH) || null : null;
  const now = Math.floor(Date.now() / 1000);

  if (input.value === undefined) {
    if (!existing) return c.json({ error: "value is required for a new secret" }, 400);
    await db.prepare("UPDATE secrets SET note = ?, updated_at = ? WHERE id = ?").bind(note, now, existing.id).run();
    return c.json({ secret: (await listSecrets(c.env, workspaceId)).find((secret) => secret.name === name) });
  }

  const value = input.value;
  if (!value) return c.json({ error: "value cannot be empty" }, 400);
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_SECRET_BYTES) return c.json({ error: `A value can be at most ${MAX_SECRET_BYTES / 1024} KB` }, 400);

  if (!existing) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE organization_id = ?").bind(workspaceId).first<{ n: number }>();
    if (Number(count?.n ?? 0) >= MAX_SECRETS) return c.json({ error: `A workspace can keep at most ${MAX_SECRETS} secrets` }, 400);
  }
  // values of the workspace's other secrets; when one no longer decrypts, the check is skipped
  const others = await secretsForRun(c.env, workspaceId).catch(() => ({} as Record<string, string>));
  delete others[name];
  const total = Object.values(others).reduce((sum, other) => sum + new TextEncoder().encode(other).length, bytes);
  if (total > MAX_TOTAL_SECRET_BYTES) {
    return c.json({ error: `A workspace's secrets can hold at most ${MAX_TOTAL_SECRET_BYTES / 1024} KB together` }, 400);
  }

  const sealed = await encryptSecret(c.env, owner, name, value);
  if (existing) {
    await db.prepare("UPDATE secrets SET value = ?, owner_user_id = ?, note = ?, updated_at = ? WHERE id = ?")
      .bind(sealed, owner, note, now, existing.id).run();
  } else {
    await db.prepare(
      "INSERT INTO secrets (organization_id, owner_user_id, name, value, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(workspaceId, owner, name, sealed, note, now, now).run();
  }
  const secret = (await listSecrets(c.env, workspaceId)).find((row) => row.name === name);
  return c.json({ secret }, existing ? 200 : 201);
});

secretsRouter.delete("/:name", requireManager, async (c) => {
  const name = c.req.param("name");
  const existing = await getDatabase(c.env).prepare("SELECT id FROM secrets WHERE organization_id = ? AND name = ?")
    .bind(c.get("workspaceId"), name).first<{ id: number }>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await getDatabase(c.env).prepare("DELETE FROM secrets WHERE id = ?").bind(existing.id).run();
  return c.body(null, 204);
});
