import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { applyMigrations, clearDb } from "./helpers";
import { dispatchDueJobs, cleanupOldExecutions } from "../src/scheduler";

beforeAll(async () => {
  await applyMigrations();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
beforeEach(async () => { await clearDb(); });

async function insertJob(params: {
  url: string;
  cron?: string;
  enabled?: number;
  next_run_at?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const cron = params.cron ?? "0 12 * * *";
  const enabled = params.enabled ?? 1;
  const next = params.next_run_at ?? now - 10;
  await env.DB.prepare(
    `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at, created_at, updated_at)
     VALUES ('j', ?, 'GET', ?, ?, 30000, ?, ?, ?)`,
  ).bind(params.url, cron, enabled, next, now, now).run();
  return (await env.DB.prepare("SELECT id FROM jobs ORDER BY id DESC LIMIT 1").first<{ id: number }>())!.id;
}

describe("dispatchDueJobs", () => {
  it("runs due jobs, records executions, and advances next_run_at", async () => {
    fetchMock.get("https://example.test").intercept({ path: "/ok" }).reply(200, "yes");
    const id = await insertJob({ url: "https://example.test/ok" });

    await dispatchDueJobs(env);

    const ex = await env.DB.prepare("SELECT * FROM executions WHERE job_id = ?").bind(id).first<{ ok: number; status_code: number }>();
    expect(ex).not.toBeNull();
    expect(ex!.ok).toBe(1);
    expect(ex!.status_code).toBe(200);

    const job = await env.DB.prepare("SELECT next_run_at, last_status FROM jobs WHERE id = ?").bind(id).first<{ next_run_at: number; last_status: string }>();
    expect(job!.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(job!.last_status).toBe("success");
  });

  it("records failure when upstream returns non-2xx", async () => {
    fetchMock.get("https://example.test").intercept({ path: "/bad" }).reply(500, "oops");
    const id = await insertJob({ url: "https://example.test/bad" });

    await dispatchDueJobs(env);

    const ex = await env.DB.prepare("SELECT ok, status_code FROM executions WHERE job_id = ?").bind(id).first<{ ok: number; status_code: number }>();
    expect(ex!.ok).toBe(0);
    expect(ex!.status_code).toBe(500);
  });

  it("skips disabled jobs", async () => {
    const id = await insertJob({ url: "https://example.test/x", enabled: 0 });
    await dispatchDueJobs(env);
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM executions WHERE job_id = ?").bind(id).first<{ c: number }>();
    expect(count!.c).toBe(0);
  });

  it("skips jobs whose next_run_at is in the future", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const id = await insertJob({ url: "https://example.test/x", next_run_at: future });
    await dispatchDueJobs(env);
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM executions WHERE job_id = ?").bind(id).first<{ c: number }>();
    expect(count!.c).toBe(0);
  });
});

describe("cleanupOldExecutions", () => {
  it("deletes executions older than 7 days and keeps newer ones", async () => {
    const id = await insertJob({ url: "https://a.b" });
    const now = Math.floor(Date.now() / 1000);
    const old = now - 8 * 86400;
    const recent = now - 86400;
    await env.DB.prepare("INSERT INTO executions (job_id, started_at, duration_ms, ok) VALUES (?, ?, 1, 1)").bind(id, old).run();
    await env.DB.prepare("INSERT INTO executions (job_id, started_at, duration_ms, ok) VALUES (?, ?, 1, 1)").bind(id, recent).run();

    await cleanupOldExecutions(env, now);

    const rows = await env.DB.prepare("SELECT started_at FROM executions").all<{ started_at: number }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0].started_at).toBe(recent);
  });
});

describe("claiming due jobs", () => {
  it("runs a due job once when two ticks overlap", async () => {
    fetchMock.get("https://example.test").intercept({ path: "/once" }).reply(200, "ok").persist();
    const id = await insertJob({ url: "https://example.test/once" });

    await Promise.all([dispatchDueJobs(env), dispatchDueJobs(env)]);

    const { results } = await env.DB.prepare("SELECT id FROM executions WHERE job_id = ?").bind(id).all();
    expect(results).toHaveLength(1);
  });

  it("keeps a schedule saved while the job ran", async () => {
    const id = await insertJob({ url: "https://example.test/slow" });
    fetchMock.get("https://example.test").intercept({ path: "/slow" }).reply(200, async () => {
      await env.DB.prepare("UPDATE jobs SET cron = '0 0 1 1 *', next_run_at = 4102444800, enabled = 0 WHERE id = ?").bind(id).run();
      return "ok";
    });

    await dispatchDueJobs(env);

    const job = await env.DB.prepare("SELECT next_run_at, enabled, last_status FROM jobs WHERE id = ?").bind(id)
      .first<{ next_run_at: number; enabled: number; last_status: string }>();
    expect(job).toEqual({ next_run_at: 4102444800, enabled: 0, last_status: "success" });
  });
});
