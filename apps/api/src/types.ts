import type { WorkerLoader } from "./loader-types";

export interface Env {
  DB?: D1Database;
  DB_PROVIDER?: "d1" | "postgres";
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  SCRIPT_KV: KVNamespace;
  BETTER_AUTH_SECRET: string;
  /** Public URL of this deployment, e.g. https://cron.example.com. Sign-in is accepted from its host and localhost. */
  APP_URL?: string;
  LOADER: WorkerLoader;
  /** "true" lets HTTP jobs and webhooks reach private or internal addresses. Off by default. */
  ALLOW_PRIVATE_TARGETS?: string;
}

export type AppHonoEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    userName: string;
    userEmail: string;
  };
};

export interface JobRow {
  id: number;
  name: string;
  url: string | null;              // null when type='script' (code stored in `script`)
  method: string;
  headers: string | null;          // JSON string in DB
  body: string | null;
  cron: string;
  enabled: number;                 // 0 | 1
  timeout_ms: number;
  next_run_at: number;
  last_run_at: number | null;
  last_status: string | null;      // 'success' | 'failed' | null
  type: "url" | "script";
  script: string | null;
  script_version: number;
  notify_targets: string | null;   // JSON-encoded NotifyTarget[] in DB
  last_notified_at: number | null; // unix seconds
  created_at: number;
  updated_at: number;
  owner_user_id: string | null;
}

export interface JobDto {
  id: number;
  name: string;
  url: string | null;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  cron: string;
  enabled: boolean;
  timeout_ms: number;
  next_run_at: number;
  last_run_at: number | null;
  last_status: "success" | "failed" | null;
  type: "url" | "script";
  script: string | null;
  script_version: number;
  notify_targets: NotifyTarget[] | null;
  last_notified_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ExecutionRow {
  id: number;
  job_id: number;
  started_at: number;
  duration_ms: number;
  status_code: number | null;
  ok: number;                      // 0 | 1
  error: string | null;
  response_snippet: string | null;
}

export type NotifyTarget =
  | { type: "http";     url: string; headers?: Record<string, string> }
  | { type: "lark";     url: string; sign_secret?: string }
  | { type: "telegram"; bot_token: string; chat_id: string }
  | { type: "dingtalk"; url: string; sign_secret?: string }
  | { type: "slack";    url: string }
  | { type: "discord";  url: string };

export function jobRowToDto(row: JobRow): JobDto {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : null,
    body: row.body,
    cron: row.cron,
    enabled: row.enabled === 1,
    timeout_ms: row.timeout_ms,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_status: (row.last_status as "success" | "failed" | null) ?? null,
    type: row.type,
    script: row.script,
    script_version: row.script_version,
    notify_targets: (() => {
      if (!row.notify_targets) return null;
      try { return JSON.parse(row.notify_targets) as NotifyTarget[]; }
      catch { console.error(`[jobs] job ${row.id}: invalid notify_targets JSON`); return null; }
    })(),
    last_notified_at: row.last_notified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
