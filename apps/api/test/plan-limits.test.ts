import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { createApp } from "../src/app";
import type { Edition } from "../src/edition";
import { applyMigrations, clearDb, createTestAccount, personalWorkspace, type TestAccount } from "./helpers";

let account: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  account = await createTestAccount("plan-limits");
});
beforeEach(async () => { await clearDb(); });

/** An edition that sells one small plan, as a hosted deployment would. */
const tiny: Edition = {
  id: "test",
  plan: async () => ({ id: "free", name: "Free", maxActiveJobs: 2, upgradeUrl: "https://cron.example.com/app/settings#plan" }),
  offers: async () => [
    { id: "free", name: "Free", priceUsd: 0, maxActiveJobs: 2 },
    { id: "team", name: "Team", priceUsd: 49, maxActiveJobs: 1000, checkoutUrl: "/api/billing/checkout?plan=team" },
  ],
};
const app = createApp(tiny);

async function call(path: string, method = "GET", body?: unknown, edition = app) {
  const response = await edition.request(`https://w${path}`, {
    method,
    headers: account.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const JOB = { name: "j", url: "https://example.com/hook", cron: "0 12 * * *" };

describe("plan limits", () => {
  it("leaves the open-source edition unmetered", async () => {
    const response = await SELF.fetch("https://w/api/usage", { headers: account.headers });
    expect(await response.json()).toEqual({ metered: false, edition: "community", jobs: { total: 0, active: 0, max: 200 } });
  });

  it("refuses to turn on a job past the plan's limit, with the upgrade link", async () => {
    expect((await call("/api/jobs", "POST", JOB)).status).toBe(201);
    expect((await call("/api/jobs", "POST", JOB)).status).toBe(201);
    const refused = await call("/api/jobs", "POST", JOB);
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({
      code: "job_limit", limit: 2, active: 2, plan: "free", upgrade_url: "https://cron.example.com/app/settings#plan",
    });
    // a job created turned off does not count
    expect((await call("/api/jobs", "POST", { ...JOB, enabled: false })).status).toBe(201);
  });

  it("refuses to turn a job back on past the limit, and allows other edits", async () => {
    const off = await call("/api/jobs", "POST", { ...JOB, enabled: false });
    await call("/api/jobs", "POST", JOB);
    await call("/api/jobs", "POST", JOB);
    const id = off.body.job.id;
    expect((await call(`/api/jobs/${id}`, "PATCH", { enabled: true })).status).toBe(402);
    expect((await call(`/api/jobs/${id}`, "PATCH", { name: "renamed" })).status).toBe(200);
  });

  it("reports the plan, the jobs and the offers", async () => {
    await call("/api/jobs", "POST", JOB);
    await call("/api/jobs", "POST", { ...JOB, enabled: false });
    const usage = await call("/api/usage");
    expect(usage.body).toMatchObject({
      metered: true,
      edition: "test",
      jobs: { total: 2, active: 1, max: 200 },
      plan: { id: "free", name: "Free", max_active_jobs: 2, upgrade_url: "https://cron.example.com/app/settings#plan" },
    });
    expect(usage.body.offers.map((offer: { id: string }) => offer.id)).toEqual(["free", "team"]);
  });

  it("raises the stored-jobs cap for a plan larger than it", async () => {
    const big = createApp({ id: "test", plan: async () => ({ id: "team", name: "Team", maxActiveJobs: 1000 }) });
    const { workspaceId, projectId } = await personalWorkspace(account);
    const now = Math.floor(Date.now() / 1000);
    const insert = env.DB.prepare(
      `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at, created_at, updated_at, owner_user_id, organization_id, project_id)
       VALUES ('j', 'https://example.com', 'GET', '0 12 * * *', 0, 30000, ?, ?, ?, ?, ?, ?)`,
    );
    await env.DB.batch(Array.from({ length: 200 }, () => insert.bind(now, now, now, account.userId, workspaceId, projectId)));
    expect((await call("/api/jobs", "POST", JOB, big)).status).toBe(201);
    expect((await call("/api/usage", "GET", undefined, big)).body.jobs).toEqual({ total: 201, active: 1, max: 1000 });
  });
});

describe("edition routes", () => {
  it("run before the built-in ones, behind the session and workspace checks", async () => {
    const guarded = createApp({
      id: "test",
      plan: async () => null,
      mount: ({ app: root, api }) => {
        root.get("/api/edition/ping", (c) => c.json({ public: true }));
        api.get("/edition/whoami", (c) => c.json({ workspace: c.get("workspaceId") }));
        api.delete("/workspaces/current", (c) => c.json({ error: "held" }, 409));
      },
    });
    expect((await guarded.request("https://w/api/edition/ping", {}, env)).status).toBe(200);
    expect((await guarded.request("https://w/api/edition/whoami", {}, env)).status).toBe(401);
    const whoami = await call("/api/edition/whoami", "GET", undefined, guarded);
    expect(whoami.body.workspace).toBe(`ws_${account.userId}`);
    expect((await call("/api/workspaces/current", "DELETE", undefined, guarded)).status).toBe(409);
  });
});
