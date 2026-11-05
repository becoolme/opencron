import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let account: TestAccount;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

beforeAll(async () => {
  await applyMigrations();
  account = await createTestAccount("jobs");
});

beforeEach(async () => {
  await clearDb();
});

const auth = (): Record<string, string> => account.headers;

describe("GET /api/jobs", () => {
  it("returns an empty list initially", async () => {
    const res = await SELF.fetch("https://w/api/jobs", { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [] });
  });
});

describe("POST /api/jobs", () => {
  it("creates a job and computes next_run_at from cron", async () => {
    const body = {
      name: "noon ping",
      url: "https://example.com/ping",
      method: "GET",
      cron: "0 12 * * *",
      enabled: true,
      timeout_ms: 15000,
    };
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { job: { id: number; cron: string; next_run_at: number; enabled: boolean } };
    expect(json.job.id).toBeGreaterThan(0);
    expect(json.job.cron).toBe("0 12 * * *");
    expect(json.job.enabled).toBe(true);
    expect(json.job.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects invalid url", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "x", url: "not a url", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid cron", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "x", url: "https://a.b", cron: "garbage" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts optional headers and body", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "posty",
        url: "https://a.b",
        method: "POST",
        headers: { "X-Key": "secret" },
        body: '{"a":1}',
        cron: "0 12 * * *",
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { job: { headers: Record<string, string>; body: string; method: string } };
    expect(json.job.method).toBe("POST");
    expect(json.job.headers).toEqual({ "X-Key": "secret" });
    expect(json.job.body).toBe('{"a":1}');
  });
});

async function createJob(overrides: Record<string, unknown> = {}) {
  const body = {
    name: "j", url: "https://a.b", cron: "0 12 * * *",
    ...overrides,
  };
  const res = await SELF.fetch("https://w/api/jobs", {
    method: "POST", headers: auth(), body: JSON.stringify(body),
  });
  return (await res.json() as { job: { id: number } }).job;
}

describe("job ownership", () => {
  it("does not expose one user's jobs to another user", async () => {
    const { id } = await createJob({ name: "private job" });
    const otherAccount = await createTestAccount("other-user");

    const list = await SELF.fetch("https://w/api/jobs", { headers: otherAccount.headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ jobs: [] });

    const detail = await SELF.fetch(`https://w/api/jobs/${id}`, { headers: otherAccount.headers });
    expect(detail.status).toBe(404);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns the job", async () => {
    const { id } = await createJob({ name: "read-me" });
    const res = await SELF.fetch(`https://w/api/jobs/${id}`, { headers: auth() });
    expect(res.status).toBe(200);
    const { job } = await res.json() as { job: { name: string } };
    expect(job.name).toBe("read-me");
  });
  it("returns 404 if missing", async () => {
    const res = await SELF.fetch(`https://w/api/jobs/99999`, { headers: auth() });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/jobs/:id", () => {
  it("updates fields", async () => {
    const { id } = await createJob();
    const res = await SELF.fetch(`https://w/api/jobs/${id}`, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ name: "updated", enabled: false }),
    });
    expect(res.status).toBe(200);
    const { job } = await res.json() as { job: { name: string; enabled: boolean } };
    expect(job.name).toBe("updated");
    expect(job.enabled).toBe(false);
  });

  it("recomputes next_run_at when cron changes", async () => {
    const { id } = await createJob({ cron: "0 12 * * *" });
    const res = await SELF.fetch(`https://w/api/jobs/${id}`, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ cron: "30 6 * * *" }),
    });
    expect(res.status).toBe(200);
    const { job } = await res.json() as { job: { cron: string; next_run_at: number } };
    expect(job.cron).toBe("30 6 * * *");
    const nowSec = Math.floor(Date.now() / 1000);
    expect(job.next_run_at).toBeGreaterThan(nowSec);
  });

  it("rejects invalid cron on update", async () => {
    const { id } = await createJob();
    const res = await SELF.fetch(`https://w/api/jobs/${id}`, {
      method: "PATCH", headers: auth(), body: JSON.stringify({ cron: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("recomputes next_run_at when re-enabling", async () => {
    const { id } = await createJob({ enabled: false });
    // Force a stale next_run_at directly.
    await env.DB.prepare("UPDATE jobs SET next_run_at = 0 WHERE id = ?").bind(id).run();
    const res = await SELF.fetch(`https://w/api/jobs/${id}`, {
      method: "PATCH", headers: auth(), body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const { job } = await res.json() as { job: { enabled: boolean; next_run_at: number } };
    expect(job.enabled).toBe(true);
    expect(job.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("updates a single field without touching others", async () => {
    const created = await createJob({
      name: "original",
      url: "https://a.b/full",
      method: "POST",
      headers: { "x-key": "v" },
      body: '{"a":1}',
      cron: "0 12 * * *",
      timeout_ms: 15000,
    });
    const res = await SELF.fetch(`https://w/api/jobs/${created.id}`, {
      method: "PATCH", headers: auth(), body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(200);
    const { job } = await res.json() as {
      job: {
        name: string; url: string; method: string;
        headers: Record<string, string>; body: string;
        cron: string; timeout_ms: number;
      };
    };
    expect(job.name).toBe("renamed");
    expect(job.url).toBe("https://a.b/full");
    expect(job.method).toBe("POST");
    expect(job.headers).toEqual({ "x-key": "v" });
    expect(job.body).toBe('{"a":1}');
    expect(job.cron).toBe("0 12 * * *");
    expect(job.timeout_ms).toBe(15000);
  });

  it("does NOT recompute next_run_at when cron is unchanged", async () => {
    const { id } = await createJob({ cron: "0 12 * * *" });
    const before = await env.DB.prepare("SELECT next_run_at FROM jobs WHERE id = ?")
      .bind(id).first<{ next_run_at: number }>();
    const res = await SELF.fetch(`https://w/api/jobs/${id}`, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ name: "still-same-cron", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(200);
    const { job } = await res.json() as { job: { next_run_at: number } };
    expect(job.next_run_at).toBe(before?.next_run_at);
  });

  it("clears headers when sent explicit null", async () => {
    const { id } = await createJob({ headers: { "x-key": "v" } });
    const payload = JSON.stringify({ headers: null });
    // Sanity: literal null must be present in the JSON body.
    expect(payload).toContain('"headers":null');
    const res = await SELF.fetch(`https://w/api/jobs/${id}`, {
      method: "PATCH", headers: auth(), body: payload,
    });
    expect(res.status).toBe(200);
    const { job } = await res.json() as { job: { headers: Record<string, string> | null } };
    expect(job.headers).toBeNull();
    const row = await env.DB.prepare("SELECT headers FROM jobs WHERE id = ?")
      .bind(id).first<{ headers: string | null }>();
    expect(row?.headers).toBeNull();
  });

  it("returns 404 for missing id", async () => {
    const res = await SELF.fetch(`https://w/api/jobs/99999`, {
      method: "PATCH", headers: auth(), body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/jobs/:id/run", () => {
  it("records an execution but does not change next_run_at", async () => {
    fetchMock.get("https://example.test").intercept({ path: "/ping" }).reply(200, "pong");

    const { id } = await createJob({ url: "https://example.test/ping" });
    const before = await env.DB.prepare("SELECT next_run_at FROM jobs WHERE id = ?").bind(id).first<{ next_run_at: number }>();

    const res = await SELF.fetch(`https://w/api/jobs/${id}/run`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);

    const after = await env.DB.prepare("SELECT next_run_at FROM jobs WHERE id = ?").bind(id).first<{ next_run_at: number }>();
    expect(after?.next_run_at).toBe(before?.next_run_at);

    const ex = await env.DB.prepare("SELECT * FROM executions WHERE job_id = ?").bind(id).first<{ status_code: number; ok: number }>();
    expect(ex?.status_code).toBe(200);
    expect(ex?.ok).toBe(1);
  });
});

describe("DELETE /api/jobs/:id", () => {
  it("deletes the job and its executions", async () => {
    const { id } = await createJob();
    // Insert a fake execution to check it is cleaned up.
    await env.DB.prepare(
      "INSERT INTO executions (job_id, started_at, duration_ms, ok) VALUES (?, ?, ?, 1)",
    ).bind(id, 1, 1).run();

    const res = await SELF.fetch(`https://w/api/jobs/${id}`, {
      method: "DELETE", headers: auth(),
    });
    expect(res.status).toBe(204);

    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM executions WHERE job_id = ?",
    ).bind(id).first<{ c: number }>();
    expect(after?.c).toBe(0);
  });

  it("returns 404 for missing id", async () => {
    const res = await SELF.fetch(`https://w/api/jobs/99999`, {
      method: "DELETE", headers: auth(),
    });
    expect(res.status).toBe(404);
  });
});
