import { guardedFetch, readCapped } from "@openuptime/kit/netguard";
import { getDatabase } from "./database";
import type { Env, JobRow } from "./types";
import { runScriptJob } from "./script-runner";
import type { LoaderExecutionContext } from "./script-runner";

export interface RunResult {
  started_at: number;
  duration_ms: number;
  status_code: number | null;
  ok: boolean;
  error: string | null;
  response_snippet: string | null;
}

async function runUrlJob(env: Env, job: JobRow): Promise<RunResult> {
  const started_at = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  let status_code: number | null = null;
  let ok = false;
  let error: string | null = null;
  let response_snippet: string | null = null;

  try {
    if (!job.url) throw new Error("url-type job has no url");
    const headers: Record<string, string> = job.headers ? JSON.parse(job.headers) : {};
    // every hop, redirects included, must be a public address unless ALLOW_PRIVATE_TARGETS is set
    const { res } = await guardedFetch(job.url, {
      method: job.method,
      headers,
      body: job.body ?? undefined,
      signal: AbortSignal.timeout(job.timeout_ms),
    }, { protectBody: true });
    status_code = res.status;
    ok = res.ok;
    response_snippet = (await readCapped(res, 4096)).slice(0, 500);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const duration_ms = Date.now() - t0;
  const ok_int = ok ? 1 : 0;

  await getDatabase(env).prepare(
    `INSERT INTO executions (job_id, started_at, duration_ms, status_code, ok, error, response_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(job.id, started_at, duration_ms, status_code, ok_int, error, response_snippet).run();

  return { started_at, duration_ms, status_code, ok, error, response_snippet };
}

/** Dispatch to the runner matching the job's type. Never throws. */
export async function runJob(env: Env, job: JobRow, ctx?: LoaderExecutionContext): Promise<RunResult> {
  return job.type === "script"
    ? await runScriptJob(env, job, ctx)
    : await runUrlJob(env, job);
}
