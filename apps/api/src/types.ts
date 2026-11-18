import type { WorkerLoader } from "./loader-types";
import type { Edition } from "./edition";

export type ScriptRuntime = "javascript" | "python" | "go";

export interface Env {
  /** Cloudflare only: the static web build (apps/web/dist). */
  ASSETS?: Fetcher;
  DB?: D1Database;
  DB_PROVIDER?: "d1" | "postgres";
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  /** Cloudflare only: storage behind the KV capability of JavaScript scripts. */
  SCRIPT_KV?: KVNamespace;
  BETTER_AUTH_SECRET: string;
  /** Public URL of this deployment, e.g. https://cron.example.com. Sign-in is accepted from its host and localhost. */
  APP_URL?: string;
  /** Cloudflare only: runs JavaScript script jobs as Dynamic Workers. */
  LOADER?: WorkerLoader;
  /**
   * Base URL of the sandbox service that runs Python and Go script jobs in containers (apps/sandbox). With Docker it is
   * the bundled service; on Cloudflare, an optional sandbox on a server of your own, reached over HTTPS.
   */
  SANDBOX_URL?: string;
  /** Shared secret the sandbox service requires on every request. */
  SANDBOX_TOKEN?: string;
  /** Optional Cloudflare Access service token, sent when the sandbox sits behind Access. */
  SANDBOX_ACCESS_CLIENT_ID?: string;
  SANDBOX_ACCESS_CLIENT_SECRET?: string;
  /** "true" lets HTTP jobs and webhooks reach private or internal addresses. Off by default. */
  ALLOW_PRIVATE_TARGETS?: string;
  /** "open" (default) or "closed": closed allows only the first account. */
  SIGNUP?: string;
}

export type WorkspaceRole = "owner" | "admin" | "member";

export type AppHonoEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    userName: string;
    userEmail: string;
    /** How the caller signed in: a browser session or an API key. */
    authMethod: "session" | "api_key";
    /** The key's scope when authMethod is api_key. */
    apiKeyScope?: "read" | "write";
    /** The browser session's id when authMethod is session. */
    sessionId?: string;
    /** For an API key: the workspace it belongs to and the projects it is limited to (null = all). */
    apiKeyWorkspaceId?: string;
    apiKeyProjectIds?: string[] | null;
    /** Set by workspaceMiddleware: the workspace of this request and the caller's role in it. */
    workspaceId: string;
    workspaceRole: WorkspaceRole;
    /** The project chosen with x-project-id, or null for the workspace-wide "all projects" view. */
    projectId: string | null;
    /** Projects this request may see: null when every project of the workspace is visible. */
    visibleProjectIds: string[] | null;
    /** The edition serving this request: its plans and their limits. */
    edition: Edition;
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
  runtime: ScriptRuntime;
  /** Alert targets saved on the job before channels existed; channel-migration.ts moves them and clears it. */
  notify_targets: string | null;
  last_notified_at: number | null; // unix seconds
  created_at: number;
  updated_at: number;
  owner_user_id: string | null;
  organization_id: string | null;
  project_id: string | null;
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
  runtime: ScriptRuntime;
  /** The alert channels that get this job's failures. */
  channel_ids: string[];
  last_notified_at: number | null;
  project_id: string | null;
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

export function jobRowToDto(row: JobRow, channelIds: string[] = []): JobDto {
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
    runtime: row.runtime ?? "javascript",
    channel_ids: channelIds,
    last_notified_at: row.last_notified_at,
    project_id: row.project_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const HIDDEN = "***";

/**
 * The job as a read-only API key sees it: request headers and the request body are replaced, so a key handed to a
 * dashboard or an agent cannot be used to call the job's target as the account. Alert credentials live in channels,
 * which are always masked.
 */
export function redactJobDto(dto: JobDto): JobDto {
  const hideValues = (headers: Record<string, string> | null | undefined) =>
    headers ? Object.fromEntries(Object.keys(headers).map((name) => [name, HIDDEN])) : headers;
  return {
    ...dto,
    headers: hideValues(dto.headers) ?? null,
    body: dto.body == null ? dto.body : HIDDEN,
  };
}
