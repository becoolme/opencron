import { getDatabase } from "../database";
import { Hono } from "hono";
import type { AppHonoEnv, JobRow } from "../types";
import { jobRowToDto } from "../types";
import { nextRunAt, validateCron } from "../cron";
import { runJob } from "../runner";

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
  notify_targets?: unknown;
};

const ALLOWED_NOTIFY_TYPES = new Set(["http", "lark", "telegram", "dingtalk", "slack", "discord"]);

const ALLOWED_KEYS_BY_TYPE: Record<string, Set<string>> = {
  http:     new Set(["type", "url", "headers"]),
  lark:     new Set(["type", "url", "sign_secret"]),
  telegram: new Set(["type", "bot_token", "chat_id"]),
  dingtalk: new Set(["type", "url", "sign_secret"]),
  slack:    new Set(["type", "url"]),
  discord:  new Set(["type", "url"]),
};

function validateNotifyTargets(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return "notify_targets must be an array or null";
  if (raw.length > 10) return "notify_targets max 10 entries";
  for (const [i, t] of raw.entries()) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return `notify_targets[${i}] must be an object`;
    const obj = t as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== "string" || !ALLOWED_NOTIFY_TYPES.has(type)) return `notify_targets[${i}].type invalid`;
    const allowed = ALLOWED_KEYS_BY_TYPE[type];
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) return `notify_targets[${i}] has unknown field "${k}"`;
    }

    switch (type) {
      case "http": {
        if (typeof obj.url !== "string" || obj.url === "") return `notify_targets[${i}].url required`;
        if (!/^https?:\/\//.test(obj.url)) return `notify_targets[${i}].url must start with http:// or https://`;
        if (obj.headers !== undefined) {
          if (!obj.headers || typeof obj.headers !== "object" || Array.isArray(obj.headers)) return `notify_targets[${i}].headers must be an object`;
          for (const [hk, hv] of Object.entries(obj.headers as Record<string, unknown>)) {
            if (typeof hk !== "string" || typeof hv !== "string") return `notify_targets[${i}].headers values must be strings`;
          }
        }
        break;
      }
      case "lark":
      case "dingtalk":
      case "slack":
      case "discord": {
        if (typeof obj.url !== "string" || obj.url === "") return `notify_targets[${i}].url required`;
        if (!obj.url.startsWith("https://")) return `notify_targets[${i}].url must start with https://`;
        if ("sign_secret" in obj && obj.sign_secret !== undefined) {
          if (typeof obj.sign_secret !== "string" || obj.sign_secret === "") return `notify_targets[${i}].sign_secret must be a non-empty string`;
        }
        break;
      }
      case "telegram": {
        if (typeof obj.bot_token !== "string" || obj.bot_token === "") return `notify_targets[${i}].bot_token required`;
        if (typeof obj.chat_id !== "string" || obj.chat_id === "") return `notify_targets[${i}].chat_id required`;
        break;
      }
    }
  }
  return null;
}

function normalizeNotifyTargets(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw) && raw.length === 0) return null;
  return JSON.stringify(raw);
}

function validateCreate(input: CreateInput): string | null {
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
  } else {
    if (!input.script || typeof input.script !== "string") return "script is required for type='script'";
    if (input.url != null) return "url must not be set when type='script'";
    if (input.method != null) return "method must not be set when type='script'";
    if (input.headers != null) return "headers must not be set when type='script'";
    if (input.body != null) return "body must not be set when type='script'";
  }
  if (input.notify_targets !== undefined) {
    const ntErr = validateNotifyTargets(input.notify_targets);
    if (ntErr) return ntErr;
  }
  return null;
}

export const jobsRouter = new Hono<AppHonoEnv>();

jobsRouter.get("/", async (c) => {
  const { results } = await getDatabase(c.env).prepare(
    "SELECT * FROM jobs WHERE owner_user_id = ? ORDER BY id DESC",
  ).bind(c.get("userId")).all<JobRow>();
  return c.json({ jobs: results.map(jobRowToDto) });
});

jobsRouter.post("/", async (c) => {
  const userId = c.get("userId");
  const input = (await c.req.json().catch(() => ({}))) as CreateInput;
  const err = validateCreate(input);
  if (err) return c.json({ error: err }, 400);

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
                         notify_targets, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'url', NULL, 1, ?, ?)
       RETURNING *`,
    )
      .bind(input.name, input.url, method, headersJson, body, input.cron, enabled, timeout, next, now, now,
            normalizeNotifyTargets(input.notify_targets), userId)
      .first<JobRow>();
  } else {
    row = await getDatabase(c.env).prepare(
      `INSERT INTO jobs (name, url, method, headers, body, cron, enabled, timeout_ms,
                         next_run_at, created_at, updated_at, type, script, script_version,
                         notify_targets, owner_user_id)
       VALUES (?, NULL, 'GET', NULL, NULL, ?, ?, ?, ?, ?, ?, 'script', ?, 1, ?, ?)
       RETURNING *`,
    )
      .bind(input.name, input.cron, enabled, timeout, next, now, now, input.script!,
            normalizeNotifyTargets(input.notify_targets), userId)
      .first<JobRow>();
  }

  return c.json({ job: jobRowToDto(row!) }, 201);
});

type UpdateInput = Partial<CreateInput> & {
  enabled?: boolean;
  type?: string;
  script?: string | null;
  notify_targets?: unknown;
};

function validateUpdate(input: UpdateInput, existingType: "url" | "script"): string | null {
  if (input.type != null && input.type !== existingType) return "type is immutable";
  if (input.cron != null && !validateCron(input.cron)) return "cron is invalid";
  if (input.timeout_ms != null) {
    if (typeof input.timeout_ms !== "number" || input.timeout_ms < 1000 || input.timeout_ms > 60000) {
      return "timeout_ms must be 1000..60000";
    }
  }

  if (existingType === "url") {
    if (input.script != null) return "script must not be set on type='url'";
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
    }
  }
  if (input.notify_targets !== undefined) {
    const ntErr = validateNotifyTargets(input.notify_targets);
    if (ntErr) return ntErr;
  }
  return null;
}

jobsRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await getDatabase(c.env).prepare(
    "SELECT * FROM jobs WHERE id = ? AND owner_user_id = ?",
  ).bind(id, c.get("userId")).first<JobRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ job: jobRowToDto(row) });
});

jobsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("userId");
  const existing = await getDatabase(c.env).prepare(
    "SELECT * FROM jobs WHERE id = ? AND owner_user_id = ?",
  ).bind(id, userId).first<JobRow>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const input = (await c.req.json().catch(() => ({}))) as UpdateInput;
  const err = validateUpdate(input, existing.type);
  if (err) return c.json({ error: err }, 400);

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
    if (input.script != null && input.script !== existing.script) {
      merged.script = input.script;
      merged.script_version = existing.script_version + 1;
    }
  }
  if (input.notify_targets !== undefined) {
    merged.notify_targets = normalizeNotifyTargets(input.notify_targets);
  }
  merged.updated_at = now;

  const cronChanged = input.cron != null && input.cron !== existing.cron;
  const reEnabled = input.enabled === true && existing.enabled === 0;
  if (cronChanged || reEnabled) {
    merged.next_run_at = nextRunAt(merged.cron, now);
  }

  await getDatabase(c.env).prepare(
    `UPDATE jobs
       SET name=?, url=?, method=?, headers=?, body=?, cron=?, enabled=?,
           timeout_ms=?, next_run_at=?, updated_at=?, script=?, script_version=?,
           notify_targets=?
     WHERE id=? AND owner_user_id=?`,
  )
    .bind(
      merged.name, merged.url, merged.method, merged.headers, merged.body,
      merged.cron, merged.enabled, merged.timeout_ms, merged.next_run_at,
      merged.updated_at, merged.script, merged.script_version,
      merged.notify_targets, id, userId,
    )
    .run();

  const updated = await getDatabase(c.env).prepare(
    "SELECT * FROM jobs WHERE id = ? AND owner_user_id = ?",
  ).bind(id, userId).first<JobRow>();
  return c.json({ job: jobRowToDto(updated!) });
});

jobsRouter.post("/:id/run", async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("userId");
  const job = await getDatabase(c.env).prepare(
    "SELECT * FROM jobs WHERE id = ? AND owner_user_id = ?",
  ).bind(id, userId).first<JobRow>();
  if (!job) return c.json({ error: "not found" }, 404);
  const result = await runJob(c.env, job, c.executionCtx);
  // Manual run does not advance next_run_at, but we do update last_run_at/last_status.
  await getDatabase(c.env).prepare(
    "UPDATE jobs SET last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
  ).bind(result.started_at, result.ok ? "success" : "failed", Math.floor(Date.now() / 1000), id, userId).run();
  return c.json({ result });
});

jobsRouter.get("/:id/executions", async (c) => {
  const id = Number(c.req.param("id"));
  const ownedJob = await getDatabase(c.env).prepare(
    "SELECT id FROM jobs WHERE id = ? AND owner_user_id = ?",
  ).bind(id, c.get("userId")).first<{ id: number }>();
  if (!ownedJob) return c.json({ error: "not found" }, 404);
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
  const userId = c.get("userId");
  const existing = await getDatabase(c.env).prepare(
    "SELECT id FROM jobs WHERE id = ? AND owner_user_id = ?",
  ).bind(id, userId).first<{ id: number }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  const db = getDatabase(c.env);
  await db.batch([
    db.prepare("DELETE FROM executions WHERE job_id = ?").bind(id),
    db.prepare("DELETE FROM jobs WHERE id = ? AND owner_user_id = ?").bind(id, userId),
  ]);
  return new Response(null, { status: 204 });
});
