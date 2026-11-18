import type { Context } from "hono";
import { Hono } from "hono";
import { getDatabase } from "../database";
import {
  CHANNEL_TYPES, MAX_CHANNELS_PER_JOB, MAX_CHANNELS_PER_WORKSPACE, MAX_CHANNEL_NAME_LENGTH,
  channelToDto, isChannelType, mergeConfig, openConfig, parseChannelConfig, sealConfig, type ChannelRow,
} from "../channels";
import { sendOne } from "../notifier";
import type { AppHonoEnv } from "../types";
import { canSeeProject, projectCondition, requireManager } from "../workspace";

/**
 * Alert channels of the current workspace. Every member sees them, with their settings masked, and picks them for
 * jobs; owners and admins create, change, test and delete them.
 */
export const channelsRouter = new Hono<AppHonoEnv>();

type Ctx = Context<AppHonoEnv, string>;

/** Projects an API key is limited to, or null when it is not limited (or the caller is a session). */
function keyProjects(c: Ctx): string[] | null {
  return c.get("authMethod") === "api_key" ? c.get("apiKeyProjectIds") ?? null : null;
}

/** A workspace-wide channel is visible to everyone; a project's channel to those who can see the project. */
function canSeeChannel(c: Ctx, projectId: string | null): boolean {
  return projectId === null || canSeeProject(c, projectId);
}

/** Changing a workspace-wide channel touches every project, which a key limited to some projects may not do. */
function canChangeChannel(c: Ctx, projectId: string | null): boolean {
  const limited = keyProjects(c);
  if (projectId === null) return limited === null;
  return !limited || limited.includes(projectId);
}

const SELECT_CHANNEL = `SELECT ch.*, (SELECT COUNT(*) FROM job_channels jc WHERE jc.channel_id = ch.id) AS job_count
  FROM alert_channels ch`;

async function findChannel(c: Ctx, id: string): Promise<(ChannelRow & { job_count: number }) | null> {
  const row = await getDatabase(c.env).prepare(`${SELECT_CHANNEL} WHERE ch.id = ? AND ch.organization_id = ?`)
    .bind(id, c.get("workspaceId")).first<ChannelRow & { job_count: number }>();
  return row && canSeeChannel(c, row.project_id) ? row : null;
}

function parseName(raw: unknown): string | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "name is required" };
  const name = raw.trim();
  if (name.length > MAX_CHANNEL_NAME_LENGTH) return { error: `name can be at most ${MAX_CHANNEL_NAME_LENGTH} characters` };
  return name;
}

/** The project a channel is limited to: null for the whole workspace, or a project of this workspace. */
async function parseProject(c: Ctx, raw: unknown): Promise<{ id: string | null } | { error: string }> {
  if (raw === null || raw === undefined || raw === "") {
    if (keyProjects(c)) return { error: "This API key is limited to some projects: set project_id" };
    return { id: null };
  }
  if (typeof raw !== "string") return { error: "project_id must be a string or null" };
  const project = await getDatabase(c.env).prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?")
    .bind(raw, c.get("workspaceId")).first<{ id: string }>();
  if (!project || !canChangeChannel(c, project.id)) return { error: "project_id is not a project of this workspace" };
  return { id: project.id };
}

function parseFlag(raw: unknown, field: string): boolean | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") return { error: `${field} must be true or false` };
  return raw;
}

const isError = (value: unknown): value is { error: string } =>
  typeof value === "object" && value !== null && "error" in value;

channelsRouter.get("/", async (c) => {
  const projects = projectCondition(c, "ch.project_id");
  const { results } = await getDatabase(c.env).prepare(
    `${SELECT_CHANNEL} WHERE ch.organization_id = ? AND (ch.project_id IS NULL OR ${projects.sql})
      ORDER BY ch.created_at, ch.id`,
  ).bind(c.get("workspaceId"), ...projects.params).all<ChannelRow & { job_count: number }>();
  return c.json({ channels: await Promise.all(results.map((row) => channelToDto(c.env, row))), types: CHANNEL_TYPES });
});

channelsRouter.get("/:id", async (c) => {
  const row = await findChannel(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ channel: await channelToDto(c.env, row) });
});

channelsRouter.post("/", requireManager, async (c) => {
  const workspaceId = c.get("workspaceId");
  const input = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return c.json({ error: "Expected a JSON object" }, 400);
  if (!isChannelType(input.type)) return c.json({ error: `type must be one of ${CHANNEL_TYPES.join(", ")}` }, 400);
  const name = parseName(input.name);
  if (isError(name)) return c.json(name, 400);
  const target = parseChannelConfig(input.type, input.config);
  if ("error" in target) return c.json(target, 400);
  const project = await parseProject(c, input.project_id);
  if ("error" in project) return c.json(project, 400);
  const enabled = parseFlag(input.enabled, "enabled");
  if (isError(enabled)) return c.json(enabled, 400);
  const autoEnable = parseFlag(input.auto_enable, "auto_enable");
  if (isError(autoEnable)) return c.json(autoEnable, 400);

  const db = getDatabase(c.env);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM alert_channels WHERE organization_id = ?").bind(workspaceId).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_CHANNELS_PER_WORKSPACE) {
    return c.json({ error: `A workspace can have at most ${MAX_CHANNELS_PER_WORKSPACE} alert channels` }, 400);
  }

  const id = `ch_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO alert_channels (id, organization_id, project_id, type, name, config, enabled, auto_enable, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, workspaceId, project.id, input.type, name, await sealConfig(c.env, id, target),
    enabled === false ? 0 : 1, autoEnable ? 1 : 0, now, now).run();
  return c.json({ channel: await channelToDto(c.env, (await findChannel(c, id))!) }, 201);
});

channelsRouter.patch("/:id", requireManager, async (c) => {
  const existing = await findChannel(c, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!canChangeChannel(c, existing.project_id)) return c.json({ error: "This API key cannot change a channel of the whole workspace" }, 403);
  const input = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return c.json({ error: "Expected a JSON object" }, 400);
  if (input.type !== undefined && input.type !== existing.type) return c.json({ error: "type cannot be changed; create a new channel" }, 400);

  let name = existing.name;
  if (input.name !== undefined) {
    const parsed = parseName(input.name);
    if (isError(parsed)) return c.json(parsed, 400);
    name = parsed;
  }
  let config = existing.config;
  if (input.config !== undefined) {
    let saved;
    try { saved = await openConfig(c.env, existing.id, existing.config); } catch { saved = null; }
    // a config that no longer decrypts has to be entered again in full
    const target = parseChannelConfig(existing.type, saved ? mergeConfig(saved, input.config) : input.config);
    if ("error" in target) return c.json(target, 400);
    config = await sealConfig(c.env, existing.id, target);
  }
  let projectId = existing.project_id;
  if (input.project_id !== undefined) {
    const project = await parseProject(c, input.project_id);
    if ("error" in project) return c.json(project, 400);
    projectId = project.id;
  }
  const enabled = parseFlag(input.enabled, "enabled");
  if (isError(enabled)) return c.json(enabled, 400);
  const autoEnable = parseFlag(input.auto_enable, "auto_enable");
  if (isError(autoEnable)) return c.json(autoEnable, 400);

  const db = getDatabase(c.env);
  await db.batch([
    db.prepare(
      "UPDATE alert_channels SET name = ?, config = ?, project_id = ?, enabled = ?, auto_enable = ?, updated_at = ? WHERE id = ?",
    ).bind(name, config, projectId,
      enabled === undefined ? existing.enabled : enabled ? 1 : 0,
      autoEnable === undefined ? existing.auto_enable : autoEnable ? 1 : 0,
      Math.floor(Date.now() / 1000), existing.id),
    // limited to one project, the channel stops alerting for jobs of the others
    ...(projectId !== null && projectId !== existing.project_id ? [db.prepare(
      "DELETE FROM job_channels WHERE channel_id = ? AND job_id IN (SELECT id FROM jobs WHERE project_id IS NULL OR project_id <> ?)",
    ).bind(existing.id, projectId)] : []),
  ]);
  return c.json({ channel: await channelToDto(c.env, (await findChannel(c, existing.id))!) });
});

channelsRouter.delete("/:id", requireManager, async (c) => {
  const existing = await findChannel(c, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  if (!canChangeChannel(c, existing.project_id)) return c.json({ error: "This API key cannot change a channel of the whole workspace" }, 403);
  const db = getDatabase(c.env);
  await db.batch([
    db.prepare("DELETE FROM job_channels WHERE channel_id = ?").bind(existing.id),
    db.prepare("DELETE FROM alert_channels WHERE id = ?").bind(existing.id),
  ]);
  return new Response(null, { status: 204 });
});

/** Sends a sample alert, so the destination can be checked without waiting for a job to fail. */
channelsRouter.post("/:id/test", requireManager, async (c) => {
  const existing = await findChannel(c, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  let target;
  try {
    target = await openConfig(c.env, existing.id, existing.config);
  } catch {
    return c.json({ ok: false, error: "The settings cannot be decrypted (was BETTER_AUTH_SECRET changed?). Enter them again." });
  }
  const error = await sendOne(target, {
    job_id: 0,
    job_name: `Test alert for ${existing.name}`,
    error: "This is a test alert. No job failed.",
    status_code: null,
    started_at: Math.floor(Date.now() / 1000),
    duration_ms: 0,
  });
  return c.json({ ok: error === null, error });
});

/** Adds the channel to every job that can use it and the caller can see. */
channelsRouter.post("/:id/apply-to-all", requireManager, async (c) => {
  const existing = await findChannel(c, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  const projects = projectCondition(c, "j.project_id");
  const { results } = await getDatabase(c.env).prepare(
    `INSERT INTO job_channels (job_id, channel_id)
       SELECT j.id, ? FROM jobs j
        WHERE j.organization_id = ? AND ${projects.sql} AND (? IS NULL OR j.project_id = ?)
          AND (SELECT COUNT(*) FROM job_channels x WHERE x.job_id = j.id) < ?
     ON CONFLICT DO NOTHING
     RETURNING job_id`,
  ).bind(existing.id, c.get("workspaceId"), ...projects.params, existing.project_id, existing.project_id, MAX_CHANNELS_PER_JOB)
    .all<{ job_id: number }>();
  return c.json({ added: results.length });
});
