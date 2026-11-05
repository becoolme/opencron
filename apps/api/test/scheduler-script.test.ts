import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { applyMigrations, clearDb } from "./helpers";
import { dispatchDueJobs } from "../src/scheduler";
import { makeLoaderMock } from "./utils/loader-mock";

beforeAll(async () => {
  await applyMigrations();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
beforeEach(async () => { await clearDb(); });

describe("dispatchDueJobs for script jobs", () => {
  it("invokes the loaded worker via LOADER and records a successful execution", async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at,
                         created_at, updated_at, type, script, script_version)
       VALUES ('scr', NULL, 'GET', '0 12 * * *', 1, 5000, ?, ?, ?, 'script',
               'export default { fetch() { return new Response("yo", { status: 200 }) } }', 3)
       RETURNING id`,
    ).bind(now - 10, now, now).first<{ id: number }>();
    const id = row!.id;

    (env as unknown as { LOADER: unknown }).LOADER = makeLoaderMock({
      [`job-${id}-v3`]: async (req) => {
        const ctx = (await req.json()) as { jobId: number; invocation: string };
        expect(ctx.jobId).toBe(id);
        expect(ctx.invocation).toBe("cron");
        return new Response("yo", { status: 200 });
      },
    });

    await dispatchDueJobs(env);

    const ex = await env.DB.prepare(
      "SELECT ok, status_code, response_snippet FROM executions WHERE job_id = ?",
    ).bind(id).first<{ ok: number; status_code: number; response_snippet: string }>();
    expect(ex).not.toBeNull();
    expect(ex!.ok).toBe(1);
    expect(ex!.status_code).toBe(200);
    expect(ex!.response_snippet).toBe("yo");

    const job = await env.DB.prepare("SELECT next_run_at, last_status FROM jobs WHERE id = ?").bind(id).first<{ next_run_at: number; last_status: string }>();
    expect(job!.last_status).toBe("success");
    expect(job!.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("does not call LOADER for disabled script jobs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at,
                         created_at, updated_at, type, script, script_version)
       VALUES ('off', NULL, 'GET', '0 12 * * *', 0, 5000, ?, ?, ?, 'script',
               'export default { fetch() { return new Response("x") } }', 1)
       RETURNING id`,
    ).bind(now - 10, now, now).first<{ id: number }>();
    const id = row!.id;

    let calls = 0;
    (env as unknown as { LOADER: unknown }).LOADER = makeLoaderMock({
      [`job-${id}-v1`]: () => { calls++; return new Response("x"); },
    });

    await dispatchDueJobs(env);
    expect(calls).toBe(0);
  });
});
