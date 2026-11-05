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
  account = await createTestAccount("notify-jobs");
});

beforeEach(async () => {
  await clearDb();
});

const auth = (): Record<string, string> => account.headers;

async function post(path: string, body: unknown): Promise<Response> {
  return await SELF.fetch(`https://w${path}`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown): Promise<Response> {
  return await SELF.fetch(`https://w${path}`, {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify(body),
  });
}

const BASE_JOB = {
  name: "test-job",
  url: "https://example.com/ping",
  cron: "0 12 * * *",
};

describe("POST /api/jobs — notify_targets validation", () => {
  it("accepts empty array — persisted as null", async () => {
    const res = await post("/api/jobs", { ...BASE_JOB, notify_targets: [] });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { notify_targets: unknown } };
    expect(job.notify_targets).toBeNull();
  });

  it("accepts explicit null", async () => {
    const res = await post("/api/jobs", { ...BASE_JOB, notify_targets: null });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { notify_targets: unknown } };
    expect(job.notify_targets).toBeNull();
  });

  it("accepts valid Lark target — round-trips", async () => {
    const target = { type: "lark", url: "https://open.larksuite.com/webhook/v1/xxx", sign_secret: "abc" };
    const res = await post("/api/jobs", { ...BASE_JOB, notify_targets: [target] });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { notify_targets: unknown[] } };
    expect(job.notify_targets).toEqual([target]);
  });

  it("accepts all 6 provider types in one array", async () => {
    const targets = [
      { type: "http", url: "https://example.com/hook" },
      { type: "lark", url: "https://open.larksuite.com/v1" },
      { type: "telegram", bot_token: "bot123", chat_id: "456" },
      { type: "dingtalk", url: "https://oapi.dingtalk.com/robot/send" },
      { type: "slack", url: "https://hooks.slack.com/services/xxx" },
      { type: "discord", url: "https://discord.com/api/webhooks/xxx" },
    ];
    const res = await post("/api/jobs", { ...BASE_JOB, notify_targets: targets });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { notify_targets: unknown[] } };
    expect(job.notify_targets).toEqual(targets);
  });

  it("rejects { type: 'pager' } → 400", async () => {
    const res = await post("/api/jobs", { ...BASE_JOB, notify_targets: [{ type: "pager" }] });
    expect(res.status).toBe(400);
  });

  it("rejects Lark without url → 400", async () => {
    const res = await post("/api/jobs", { ...BASE_JOB, notify_targets: [{ type: "lark" }] });
    expect(res.status).toBe(400);
  });

  it("rejects Lark with http:// (non-https) → 400", async () => {
    const res = await post("/api/jobs", {
      ...BASE_JOB,
      notify_targets: [{ type: "lark", url: "http://open.larksuite.com/webhook" }],
    });
    expect(res.status).toBe(400);
  });

  it("allows http type to use http:// scheme → 201", async () => {
    const res = await post("/api/jobs", {
      ...BASE_JOB,
      notify_targets: [{ type: "http", url: "http://internal.example.com/hook" }],
    });
    expect(res.status).toBe(201);
  });

  it("rejects 11 targets (max = 10) → 400", async () => {
    const targets = Array.from({ length: 11 }, (_, i) => ({
      type: "http",
      url: `https://example.com/hook${i}`,
    }));
    const res = await post("/api/jobs", { ...BASE_JOB, notify_targets: targets });
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields on target (e.g., foo: 'bar') → 400", async () => {
    const res = await post("/api/jobs", {
      ...BASE_JOB,
      notify_targets: [{ type: "http", url: "https://example.com/hook", foo: "bar" }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects Telegram missing chat_id → 400", async () => {
    const res = await post("/api/jobs", {
      ...BASE_JOB,
      notify_targets: [{ type: "telegram", bot_token: "bot123" }],
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/jobs/:id — notify_targets persistence", () => {
  async function createJob(overrides: Record<string, unknown> = {}) {
    const res = await post("/api/jobs", { ...BASE_JOB, ...overrides });
    return ((await res.json()) as { job: { id: number } }).job;
  }

  it("clearing targets by sending null → targets become null", async () => {
    const { id } = await createJob({
      notify_targets: [{ type: "http", url: "https://example.com/hook" }],
    });
    const res = await patch(`/api/jobs/${id}`, { notify_targets: null });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: { notify_targets: unknown } };
    expect(job.notify_targets).toBeNull();
    const row = await env.DB.prepare("SELECT notify_targets FROM jobs WHERE id = ?")
      .bind(id)
      .first<{ notify_targets: string | null }>();
    expect(row?.notify_targets).toBeNull();
  });

  it("replacing targets by sending a new array → replaces atomically", async () => {
    const originalTarget = [{ type: "http", url: "https://example.com/hook1" }];
    const { id } = await createJob({ notify_targets: originalTarget });

    const newTargets = [
      { type: "lark", url: "https://open.larksuite.com/v2" },
      { type: "slack", url: "https://hooks.slack.com/services/yyy" },
    ];
    const res = await patch(`/api/jobs/${id}`, { notify_targets: newTargets });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: { notify_targets: unknown[] } };
    expect(job.notify_targets).toEqual(newTargets);
  });

  it("leaving notify_targets key absent from PATCH → existing targets untouched", async () => {
    const target = [{ type: "discord", url: "https://discord.com/api/webhooks/zzz" }];
    const { id } = await createJob({ notify_targets: target });

    const res = await patch(`/api/jobs/${id}`, { name: "renamed-job" });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: { name: string; notify_targets: unknown } };
    expect(job.name).toBe("renamed-job");
    expect(job.notify_targets).toEqual(target);
  });
});
