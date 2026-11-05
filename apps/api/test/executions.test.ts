import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let account: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  account = await createTestAccount("executions");
});
beforeEach(async () => { await clearDb(); });

const auth = (): Record<string, string> => account.headers;

async function seed() {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at, created_at, updated_at, owner_user_id)
     VALUES ('j','https://a.b','GET','0 12 * * *',1,30000,?,?,?,?)`,
  ).bind(now, now, now, account.userId).run();
  const job = await env.DB.prepare("SELECT id FROM jobs LIMIT 1").first<{ id: number }>();
  const rows = [
    { t: now - 10, code: 200, ok: 1 },
    { t: now - 20, code: 500, ok: 0 },
    { t: now - 30, code: 200, ok: 1 },
  ];
  for (const r of rows) {
    await env.DB.prepare(
      "INSERT INTO executions (job_id, started_at, duration_ms, status_code, ok) VALUES (?, ?, 10, ?, ?)",
    ).bind(job!.id, r.t, r.code, r.ok).run();
  }
  return job!.id;
}

describe("GET /api/executions", () => {
  it("returns recent executions across all jobs, newest first", async () => {
    await seed();
    const res = await SELF.fetch("https://w/api/executions?limit=2", { headers: auth() });
    expect(res.status).toBe(200);
    const { executions } = await res.json() as { executions: { status_code: number; started_at: number }[] };
    expect(executions.length).toBe(2);
    expect(executions[0].started_at).toBeGreaterThan(executions[1].started_at);
  });
});

describe("GET /api/jobs/:id/executions", () => {
  it("returns history for a single job", async () => {
    const id = await seed();
    const res = await SELF.fetch(`https://w/api/jobs/${id}/executions`, { headers: auth() });
    expect(res.status).toBe(200);
    const { executions } = await res.json() as { executions: unknown[] };
    expect(executions.length).toBe(3);
  });
});
