import type { Context } from "hono";
import { getDatabase } from "../database";
import { Hono } from "hono";
import type { AppHonoEnv, JobRow } from "../types";
import { jobRowToDto, redactJobDto } from "../types";
import { nextRunAt, validateCron } from "../cron";
import { runJob } from "../runner";
import { maybeNotify } from "../notifier";
import { availableRuntimes, isScriptRuntime } from "../runtimes";
import type { Env } from "../types";
import { canSeeProject, projectCondition, projectForNewJob } from "../workspace";
import {
  channelIdsByJob, defaultChannelIds, dropForeignChannelsStatement, parseChannelIds, setJobChannelStatements,
} from "../channels";

/** Jobs one workspace can keep; each runs on the shared scheduler tick. */
export const MAX_JOBS_PER_WORKSPACE = 200;

/** Largest script accepted, in characters. */
const MAX_SCRIPT_LENGTH = 256 * 1024;

function validateRuntime(env: Env, runtime: unknown): string | null {
  if (!isScriptRuntime(runtime)) return "runtime must be 'javascript', 'python' or 'go'";
  if (!availableRuntimes(env).includes(runtime)) return `runtime '${runtime}' is not available on this deployment`;
  return null;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

type CreateInput = {
  name?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string> | null;
  body?: string | null;
  cron?: string;
  enabled?: boolean;
  timeout_ms?: number;
  type?: string;
  script?: string;
  runtime?: string;
  channel_ids?: unknown;
  notify_targets?: unknown;
  project_id?: unknown;
};

/** notify_targets kept alert destinations on each job; they now live in alert channels. */
export const NOTIFY_TARGETS_GONE =
  "notify_targets was replaced by alert channels: create channels with /api/channels and send their ids as channel_ids";

function validateCreate(env: Env, input: CreateInput): string | null {
  if (!input.name || typeof input.name !== "string") return "name is required";
  const type = (input.type ?? "url");
  if (type !== "url" && type !== "script") return "type must be 'url' or 'script'";
  if (!input.cron || !validateCron(input.cron)) return "cron is invalid";
  const timeout = input.timeout_ms ?? 30000;
  if (typeof timeout !== "number" || timeout < 1000 || timeout > 60000) return "timeout_ms must be 1000..60000";

  if (type === "url") {
    if (!input.url || typeof input.url !== "string") return "url is required for type='url'";
    try { new URL(input.url); } catch { return "url is not a valid URL"; }
    const method = (input.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) return "method is not allowed";
    if (input.headers != null) {
      if (typeof input.headers !== "object" || Array.isArray(input.headers)) return "headers must be an object";
      for (const [k, v] of Object.entries(input.headers)) {
        if (typeof k !== "string" || typeof v !== "string") return "headers values must be strings";
      }
    }
    if (input.body != null && typeof input.body !== "string") return "body must be a string";
    if (input.script != null) return "script must not be set when type='url'";
    if (input.runtime != null) return "runtime must not be set when type='url'";
  } else {
    if (!input.script || typeof input.script !== "string") return "script is required for type='script'";
    if (input.script.length > MAX_SCRIPT_LENGTH) return "script is too long (256 KB at most)";
    const runtimeErr = validateRuntime(env, input.runtime ?? "javascript");
    if (runtimeErr) return runtimeErr;
    if (input.url != null) return "url must not be set when type='script'";
    if (input.method != null) return "method must not be set when type='script'";
    if (input.headers != null) return "headers must not be set when type='script'";
    if (input.body != null) return "body must not be set when type='script'";
  }
  if (input.notify_targets !== undefined) return NOTIFY_TARGETS_GONE;
  return null;
}

/** Workers pass an ExecutionContext (its exports carry the storage capabilities); Node has none, and Hono throws. */
// Node (the Docker server) has no ExecutionContext and Hono throws when it is read there
function executionContext(c: Context<AppHonoEnv, string>): ExecutionContext | undefined {
  try { return c.executionCtx as unknown as ExecutionContext; } catch { return undefined; }
}

/** Read-only API keys get jobs without credentials; sessions and write keys can change them anyway. */
function toDto(c: Context<AppHonoEnv, string>, row: JobRow, channelIds: string[]) {
  const dto = jobRowToDto(row, channelIds);
  return c.get("authMethod") === "api_key" && c.get("apiKeyScope") === "read" ? redactJobDto(dto) : dto;
}

async function jobResponse(c: Context<AppHonoEnv, string>, id: number) {
  const row = await getDatabase(c.env).prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  const channels = await channelIdsByJob(c.env, [id]);
  return toDto(c, row!, channels.get(id) ?? []);
}

/** A job of the current workspace that this request may see, or null. */
async function findJob(c: Context<AppHonoEnv, string>, id: number): Promise<JobRow | null> {
  if (!Number.isSafeInteger(id)) return null;
  const row = await getDatabase(c.env).prepare("SELECT * FROM jobs WHERE id = ? AND organization_id = ?")
    .bind(id, c.get("workspaceId")).first<JobRow>();
  return row && canSeeProject(c, row.project_id) ? row : null;
}

export const jobsRouter = new Hono<AppHonoEnv>();

jobsRouter.get("/", async (c) => {
  const projects = projectCondition(c, "project_id");
  const { results } = await getDatabase(c.env).prepare(
    `SELECT * FROM jobs WHERE organization_id = ? AND ${projects.sql} ORDER BY id DESC`,
  ).bind(c.get("workspaceId"), ...projects.params).all<JobRow>();
  const channels = await channelIdsByJob(c.env, results.map((row) => row.id));
  return c.json({ jobs: results.map((row) => toDto(c, row, channels.get(row.id) ?? [])) });
});

jobsRouter.post("/", async (c) => {
  const userId = c.get("userId");
  const workspaceId = c.get("workspaceId");
  const input = (await c.req.json().catch(() => ({}))) as CreateInput;
  const err = validateCreate(c.env, input);
  if (err) return c.json({ error: err }, 400);
  const project = await projectForNewJob(c, input.project_id);
  if ("error" in project) return c.json({ error: project.error }, 400);
  const count = await getDatabase(c.env).prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ?")
    .bind(workspaceId).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_JOBS_PER_WORKSPACE) {
    return c.json({ error: `A workspace can have at most ${MAX_JOBS_PER_WORKSPACE} jobs` }, 400);
  }
  // without channel_ids, a new job gets the workspace's default channels
  const channelIds = input.channel_ids === undefined
    ? await defaultChannelIds(c.env, workspaceId, project.id)
    : await parseChannelIds(c.env, workspaceId, project.id, input.channel_ids);
  if ("error" in channelIds) return c.json({ error: channelIds.error }, 400);

  const now = Math.floor(Date.now() / 1000);
  const type = input.type ?? "url";
  const enabled = input.enabled === false ? 0 : 1;
  const timeout = input.timeout_ms ?? 30000;
  const next = nextRunAt(input.cron!, now);

  let row: JobRow | null;
  if (type === "url") {
    const method = (input.method ?? "GET").toUpperCase();
    const headersJson = input.headers ? JSON.stringify(input.headers) : null;
    const body = input.body ?? null;
    row = await getDatabase(c.env).prepare(
      `INSERT INTO jobs (name, url, method, headers, body, cron, enabled, timeout_ms,
                         next_run_at, created_at, updated_at, type, script, script_version,
                         owner_user_id, organization_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'url', NULL, 1, ?, ?, ?)
       RETURNING *`,
    )
      .bind(input.name, input.url, method, headersJson, body, input.cron, enabled, timeout, next, now, now,
            userId, workspaceId, project.id)
      .first<JobRow>();
  } else {
    row = await getDatabase(c.env).prepare(
      `INSERT INTO jobs (name, url, method, headers, body, cron, enabled, timeout_ms,
                         next_run_at, created_at, updated_at, type, script, script_version,
                         runtime, owner_user_id, organization_id, project_id)
       VALUES (?, NULL, 'GET', NULL, NULL, ?, ?, ?, ?, ?, ?, 'script', ?, 1, ?, ?, ?, ?)
       RETURNING *`,
    )
      .bind(input.name, input.cron, enabled, timeout, next, now, now, input.script!, input.runtime ?? "javascript",
            userId, workspaceId, project.id)
      .first<JobRow>();
  }

  if (channelIds.length > 0) {
    const db = getDatabase(c.env);
    await db.batch(setJobChannelStatements(db, row!.id, channelIds));
  }
  return c.json({ job: toDto(c, row!, channelIds) }, 201);
});

type UpdateInput = Partial<CreateInput> & {
  enabled?: boolean;
  type?: string;
  script?: string | null;
};

function validateUpdate(env: Env, input: UpdateInput, existingType: "url" | "script"): string | null {
  if (input.type != null && input.type !== existingType) return "type is immutable";
  if (input.cron != null && !validateCron(input.cron)) return "cron is invalid";
  if (input.timeout_ms != null) {
    if (typeof input.timeout_ms !== "number" || input.timeout_ms < 1000 || input.timeout_ms > 60000) {
      return "timeout_ms must be 1000..60000";
    }
  }

  if (existingType === "url") {
    if (input.script != null) return "script must not be set on type='url'";
    if (input.runtime != null) return "runtime must not be set on type='url'";
    if (input.url != null) {
      if (typeof input.url !== "string") return "url must be a string";
      try { new URL(input.url); } catch { return "url is not a valid URL"; }
    }
    if (input.method != null) {
      if (!ALLOWED_METHODS.has(input.method.toUpperCase())) return "method is not allowed";
    }
    if (input.headers !== undefined && input.headers !== null) {
      if (typeof input.headers !== "object" || Array.isArray(input.headers)) return "headers must be an object";
      for (const [k, v] of Object.entries(input.headers)) {
        if (typeof k !== "string" || typeof v !== "string") return "headers values must be strings";
      }
    }
    if (input.body !== undefined && input.body !== null && typeof input.body !== "string") return "body must be a string";
  } else {
    if (input.url != null) return "url must not be set on type='script'";
    if (input.method != null) return "method must not be set on type='script'";
    if (input.headers != null) return "headers must not be set on type='script'";
    if (input.body != null) return "body must not be set on type='script'";
    if (input.script != null) {
      if (typeof input.script !== "string" || input.script === "") return "script must be a non-empty string";
      if (input.script.length > MAX_SCRIPT_LENGTH) return "script is too long (256 KB at most)";
    }
    if (input.runtime != null) {
      const runtimeErr = validateRuntime(env, input.runtime);
      if (runtimeErr) return runtimeErr;
    }
  }
  if (input.notify_targets !== undefined) return NOTIFY_TARGETS_GONE;
  return null;
}

jobsRouter.get("/:id", async (c) => {
  const row = await findJob(c, Number(c.req.param("id")));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ job: await jobResponse(c, row.id) });
});

jobsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await findJob(c, id);
  if (!existing) return c.json({ error: "not found" }, 404);

  const input = (await c.req.json().catch(() => ({}))) as UpdateInput;
  const err = validateUpdate(c.env, input, existing.type);
  if (err) return c.json({ error: err }, 400);
  let projectId = existing.project_id;
  if (input.project_id !== undefined && input.project_id !== existing.project_id) {
    // moving a job: its script storage is keyed by the job and goes with it
    if (input.project_id === null) return c.json({ error: "project_id cannot be null" }, 400);
    const project = await projectForNewJob(c, input.project_id);
    if ("error" in project) return c.json({ error: project.error }, 400);
    projectId = project.id;
  }
  let channelIds: string[] | null = null;
  if (input.channel_ids !== undefined) {
    const parsed = await parseChannelIds(c.env, existing.organization_id!, projectId!, input.channel_ids);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    channelIds = parsed;
  }

  const now = Math.floor(Date.now() / 1000);
  const merged: JobRow = { ...existing };
  if (input.name != null) merged.name = input.name;
  if (input.cron != null) merged.cron = input.cron;
  if (input.enabled != null) merged.enabled = input.enabled ? 1 : 0;
  if (input.timeout_ms != null) merged.timeout_ms = input.timeout_ms;

  if (existing.type === "url") {
    if (input.url != null) merged.url = input.url;
    if (input.method != null) merged.method = input.method.toUpperCase();
    if (input.headers !== undefined) merged.headers = input.headers === null ? null : JSON.stringify(input.headers);
    if (input.body !== undefined) merged.body = input.body ?? null;
  } else {
    const scriptChanged = input.script != null && input.script !== existing.script;
    const runtimeChanged = input.runtime != null && input.runtime !== existing.runtime;
    if (scriptChanged) merged.script = input.script!;
    if (runtimeChanged) merged.runtime = input.runtime as JobRow["runtime"];
    if (scriptChanged || runtimeChanged) merged.script_version = existing.script_version + 1;
  }
  merged.updated_at = now;

  const cronChanged = input.cron != null && input.cron !== existing.cron;
  const reEnabled = input.enabled === true && existing.enabled === 0;
  if (cronChanged || reEnabled) {
    merged.next_run_at = nextRunAt(merged.cron, now);
  }

  const db = getDatabase(c.env);
  await db.batch([
    db.prepare(
      `UPDATE jobs
         SET name=?, url=?, method=?, headers=?, body=?, cron=?, enabled=?,
             timeout_ms=?, next_run_at=?, updated_at=?, script=?, script_version=?,
             runtime=?, project_id=?
       WHERE id=? AND organization_id=?`,
    ).bind(
      merged.name, merged.url, merged.method, merged.headers, merged.body,
      merged.cron, merged.enabled, merged.timeout_ms, merged.next_run_at,
      merged.updated_at, merged.script, merged.script_version,
      merged.runtime ?? "javascript", projectId, id, existing.organization_id,
    ),
    // a job moved to another project keeps only the channels it can use there
    ...(channelIds ? setJobChannelStatements(db, id, channelIds)
      : projectId !== existing.project_id ? [dropForeignChannelsStatement(db, id, projectId!)] : []),
  ]);

  return c.json({ job: await jobResponse(c, id) });
});

jobsRouter.post("/:id/run", async (c) => {
  const id = Number(c.req.param("id"));
  const job = await findJob(c, id);
  if (!job) return c.json({ error: "not found" }, 404);
  const result = await runJob(c.env, job, executionContext(c));
  // Manual run does not advance next_run_at, but we do update last_run_at/last_status.
  await getDatabase(c.env).prepare(
    "UPDATE jobs SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?",
  ).bind(result.started_at, result.ok ? "success" : "failed", Math.floor(Date.now() / 1000), id).run();
  // a failed manual run alerts like a scheduled one; the one-minute dedupe keeps repeated clicks quiet
  try {
    await maybeNotify(c.env, job, result);
  } catch (error) {
    console.error(`[jobs] job ${id}: alerts failed:`, error);
  }
  return c.json({ result });
});

jobsRouter.get("/:id/executions", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await findJob(c, id))) return c.json({ error: "not found" }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? "20") || 20, 200);
  const before = Number(c.req.query("before") ?? "0") || 0;
  const stmt = before > 0
    ? getDatabase(c.env).prepare("SELECT * FROM executions WHERE job_id = ? AND started_at < ? ORDER BY started_at DESC LIMIT ?").bind(id, before, limit)
    : getDatabase(c.env).prepare("SELECT * FROM executions WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").bind(id, limit);
  const { results } = await stmt.all();
  return c.json({ executions: results });
});

jobsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await findJob(c, id);
  if (!existing) return c.json({ error: "not found" }, 404);
  const db = getDatabase(c.env);
  await db.batch([
    db.prepare("DELETE FROM executions WHERE job_id = ?").bind(id),
    db.prepare("DELETE FROM job_channels WHERE job_id = ?").bind(id),
    db.prepare("DELETE FROM jobs WHERE id = ?").bind(id),
  ]);
  const kv = c.env.SCRIPT_KV;
  if (kv) {
    // Workers KV has no prefix delete; values a script kept there are removed after the response
    // the KV keys of a job are scoped by the account that created it, not by whoever deletes it
    const cleanup = deleteKvPrefix(kv, `opencron:v1:user:${existing.owner_user_id}:job:${id}:`)
      .catch((error) => console.error(`[jobs] job ${id}: KV cleanup failed:`, error));
    executionContext(c)?.waitUntil(cleanup);
  }
  return new Response(null, { status: 204 });
});

export async function deleteKvPrefix(kv: KVNamespace, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    await Promise.all(page.keys.map((key) => kv.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
