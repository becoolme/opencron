export type JobType = "url" | "script";
export type ScriptRuntime = "javascript" | "python" | "go";
export type NotifyType = "http" | "lark" | "telegram" | "dingtalk" | "slack" | "discord";

export type NotifyTarget =
  | { type: "telegram"; bot_token: string; chat_id: string }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "lark" | "dingtalk"; url: string; sign_secret?: string }
  | { type: "slack" | "discord"; url: string };

export interface Job {
  id: number;
  name: string;
  type: JobType;
  url: string | null;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  script: string | null;
  script_version: number;
  /** Always set; URL jobs report "javascript". */
  runtime: ScriptRuntime;
  cron: string;
  timeout_ms: number;
  enabled: boolean;
  notify_targets: NotifyTarget[] | null;
  last_notified_at: number | null;
  last_status: "success" | "failed" | null;
  last_run_at: number | null;
  next_run_at: number;
  created_at: number;
  updated_at: number;
}

export const RUNTIME_LABEL: Record<ScriptRuntime, string> = { javascript: "JavaScript", python: "Python", go: "Go" };

/** An execution as the API sends it: `ok` is stored as 0 or 1. */
export type ExecutionWire = Omit<Execution, "ok"> & { ok: number | boolean };

export interface Execution {
  id: number;
  job_id: number;
  started_at: number;
  ok: boolean;
  status_code: number | null;
  duration_ms: number;
  error: string | null;
  response_snippet: string | null;
}

export interface JobForm {
  id: number | null;
  name: string;
  type: JobType;
  url: string;
  method: string;
  headers: HeaderRow[];
  body: string;
  script: string;
  runtime: ScriptRuntime;
  cron: string;
  timeout_ms: number;
  enabled: boolean;
  notify_targets: NotifyTarget[];
  last_notified_at: number | null;
}

export interface NotifyDraft {
  type: NotifyType;
  url: string;
  bot_token: string;
  chat_id: string;
  sign_secret: string;
  headers_text: string;
}

export interface HeaderRow {
  key: string;
  value: string;
}
