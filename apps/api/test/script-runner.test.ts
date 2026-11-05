import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { JobRow } from "../src/types";
import { applyMigrations, clearDb } from "./helpers";
import { makeLoaderMock } from "./utils/loader-mock";
import { buildWorkerCode, runScriptJob } from "../src/script-runner";

beforeAll(async () => { await applyMigrations(); });
beforeEach(async () => { await clearDb(); });

async function insertScriptJob(partial: Partial<JobRow> = {}): Promise<JobRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at,
                       created_at, updated_at, type, script, script_version)
     VALUES (?, NULL, 'GET', '0 12 * * *', 1, ?, ?, ?, ?, 'script', ?, ?)
     RETURNING *`,
  ).bind(
    partial.name ?? "s",
    partial.timeout_ms ?? 30000,
    partial.next_run_at ?? now,
    now,
    now,
    "script" in partial ? partial.script : "export default { fetch() { return new Response('hi') } }",
    partial.script_version ?? 1,
  ).first<JobRow>();
  return row!;
}

describe("runScriptJob", () => {
  it("only forwards serializable bindings to the dynamic worker", () => {
    const code = buildWorkerCode(env, "export default {}");

    expect(code.env).toEqual({});
    expect(code.globalOutbound).toBeNull();
    expect(code.env).not.toHaveProperty("LOADER");
    expect(code.env).not.toHaveProperty("DB");
    expect(code.env).not.toHaveProperty("BETTER_AUTH_SECRET");
  });

  it("forwards a user/job-scoped storage facade through the RPC entrypoint", () => {
    const tablesStub = { tables: true };
    const dbStub = { rpc: true };
    const d1Stub = { d1: true };
    const kvStub = { kv: true };
    const receivedProps: unknown[] = [];
    const code = buildWorkerCode(env, "export default {}", {
      exports: {
        OpenCronTables: (options: unknown) => {
          receivedProps.push(options);
          return tablesStub;
        },
        OpenCronDatabase: (options: unknown) => {
          receivedProps.push(options);
          return dbStub;
        },
        OpenCronD1: (options: unknown) => {
          receivedProps.push(options);
          return d1Stub;
        },
        OpenCronKV: (options: unknown) => {
          receivedProps.push(options);
          return kvStub;
        },
      },
    }, { id: 42, owner_user_id: "user-1" });

    expect(code.env).toEqual({ db: tablesStub, DB: dbStub, D1: d1Stub, KV: kvStub });
    expect(receivedProps).toEqual([
      { props: { userId: "user-1", jobId: 42 } },
      { props: { userId: "user-1", jobId: 42 } },
      { props: { userId: "user-1", jobId: 42 } },
      { props: { userId: "user-1", jobId: 42 } },
    ]);
  });

  it("records a success execution when the script returns 2xx", async () => {
    const job = await insertScriptJob();
    (env as unknown as { LOADER: unknown }).LOADER = makeLoaderMock({
      [`job-${job.id}-v${job.script_version}`]: async () => new Response("ok-body", { status: 200 }),
    });

    const result = await runScriptJob(env, job);

    expect(result.ok).toBe(true);
    expect(result.status_code).toBe(200);
    expect(result.response_snippet).toBe("ok-body");
    expect(result.error).toBeNull();

    const ex = await env.DB.prepare(
      "SELECT ok, status_code, response_snippet FROM executions WHERE job_id = ?",
    ).bind(job.id).first<{ ok: number; status_code: number; response_snippet: string }>();
    expect(ex!.ok).toBe(1);
    expect(ex!.status_code).toBe(200);
    expect(ex!.response_snippet).toBe("ok-body");
  });

  it("records failure when the script returns non-2xx", async () => {
    const job = await insertScriptJob();
    (env as unknown as { LOADER: unknown }).LOADER = makeLoaderMock({
      [`job-${job.id}-v${job.script_version}`]: async () => new Response("err-body", { status: 500 }),
    });

    const result = await runScriptJob(env, job);

    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(500);
    expect(result.response_snippet).toBe("err-body");
    expect(result.error).toBeNull();
  });

  it("records error when the script handler throws", async () => {
    const job = await insertScriptJob();
    (env as unknown as { LOADER: unknown }).LOADER = makeLoaderMock({
      [`job-${job.id}-v${job.script_version}`]: () => { throw new Error("boom"); },
    });

    const result = await runScriptJob(env, job);

    expect(result.ok).toBe(false);
    expect(result.status_code).toBeNull();
    expect(result.error).toBe("boom");
  });

  it("records error when the script handler exceeds timeout_ms", async () => {
    const job = await insertScriptJob({ timeout_ms: 1000 });
    (env as unknown as { LOADER: unknown }).LOADER = makeLoaderMock({
      [`job-${job.id}-v${job.script_version}`]: () => new Promise(() => { /* never resolves */ }),
    });

    const result = await runScriptJob(env, job);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
  });

  it("records error when the job has no script (should never happen in practice)", async () => {
    const job = await insertScriptJob({ script: null as unknown as string });
    const result = await runScriptJob(env, job);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/script is empty/);
  });
});
