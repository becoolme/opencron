import { getDatabase } from "./database";
import type { Env, JobRow } from "./types";
import type { WorkerCode } from "./loader-types";
import type { RunResult } from "./runner";
import { runInSandbox, tail } from "./sandbox-client";
import { maskSecrets, secretsFingerprint, secretsForRun } from "./secrets";

type DynamicBindings = {
  db?: unknown;
  DB?: unknown;
  D1?: unknown;
  KV?: unknown;
  [secret: string]: unknown;
};

export type LoaderExecutionContext = object;

export function buildWorkerCode(
  env: Env,
  source: string,
  ctx?: LoaderExecutionContext,
  storageScope?: Pick<JobRow, "id" | "owner_user_id">,
  secrets: Record<string, string> = {},
): WorkerCode {
  // the account's secrets, as plain strings; their names cannot shadow the bindings set below
  const childEnv: DynamicBindings = { ...secrets };

  const ctxExports = (ctx as { readonly exports?: unknown } | undefined)?.exports;
  if (ctxExports && storageScope?.owner_user_id) {
    const exports = ctxExports as {
      OpenCronTables(options: { props: { userId: string; jobId: number } }): unknown;
      OpenCronDatabase(options: { props: { userId: string; jobId: number } }): unknown;
      OpenCronD1(options: { props: { userId: string; jobId: number } }): unknown;
      OpenCronKV(options: { props: { userId: string; jobId: number } }): unknown;
    };
    const props = { userId: storageScope.owner_user_id, jobId: storageScope.id };
    childEnv.db = exports.OpenCronTables({ props });
    childEnv.DB = exports.OpenCronDatabase({ props });
    childEnv.D1 = exports.OpenCronD1({ props });
    childEnv.KV = exports.OpenCronKV({ props });
  }

  return {
    compatibilityDate: "2026-03-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "main.js",
    modules: { "main.js": source },
    // Sandboxed scripts can only reach explicitly provided capabilities.
    globalOutbound: null,
    // WorkerLoader and native D1 bindings are not serializable across isolates.
    // Authentication secrets never enter the child isolate. DB is the legacy
    // facade; D1 and KV are scoped RPC capabilities. Native bindings stay private.
    env: childEnv,
  };
}

export async function runScriptJob(env: Env, job: JobRow, ctx?: LoaderExecutionContext): Promise<RunResult> {
  const started_at = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  let status_code: number | null = null;
  let ok = false;
  let error: string | null = null;
  let response_snippet: string | null = null;
  let secrets: Record<string, string> = {};

  try {
    if (!job.script) throw new Error("script is empty");
    const runtime = job.runtime ?? "javascript";
    secrets = await secretsForRun(env, job.owner_user_id);
    if (runtime === "javascript" && env.LOADER) {
      // a changed secret gets a fresh isolate rather than one holding the old values
      const fingerprint = await secretsFingerprint(secrets);
      const handle = env.LOADER.get(
        `job-${job.id}-v${job.script_version}${fingerprint ? `-s${fingerprint}` : ""}`,
        () => buildWorkerCode(env, job.script!, ctx, job, secrets),
      );
      const entrypoint = handle.getEntrypoint();
      const req = new Request("https://opencron.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(job.timeout_ms),
        body: JSON.stringify({
          jobId: job.id,
          jobName: job.name,
          scheduledAt: started_at,
          invocation: "cron",
        }),
      });
      const res = await entrypoint.fetch(req);
      status_code = res.status;
      ok = res.ok;
      // masked before it is cut, so a secret across the cut cannot leave a readable piece behind
      response_snippet = (maskSecrets(await res.text(), secrets) ?? "").slice(0, 500);
    } else if (env.SANDBOX_URL) {
      const run = await runInSandbox(env, {
        runtime,
        source: job.script,
        timeout_ms: job.timeout_ms,
        context: { jobId: job.id, jobName: job.name, scheduledAt: started_at, invocation: "cron" },
        owner: job.owner_user_id ?? undefined,
        env: secrets,
      });
      ok = run.exit_code === 0 && !run.timed_out;
      const stdout = maskSecrets(run.stdout, secrets);
      const stderr = maskSecrets(run.stderr.trim(), secrets);
      response_snippet = stdout ? tail(stdout, 500) : null;
      if (run.timed_out) error = `Timed out after ${job.timeout_ms} ms`;
      else if (!ok) error = stderr ? tail(stderr, 1000) : `Exited with code ${run.exit_code}`;
    } else {
      throw new Error(`This deployment cannot run ${runtime} scripts`);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // a script that prints a secret does not leave it in the run history
  error = maskSecrets(error, secrets);
  response_snippet = maskSecrets(response_snippet, secrets);

  const duration_ms = Date.now() - t0;
  const ok_int = ok ? 1 : 0;

  await getDatabase(env).prepare(
    `INSERT INTO executions (job_id, started_at, duration_ms, status_code, ok, error, response_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(job.id, started_at, duration_ms, status_code, ok_int, error, response_snippet).run();

  return { started_at, duration_ms, status_code, ok, error, response_snippet };
}
