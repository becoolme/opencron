import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { applyMigrations, clearDb, createTestAccount, insertChannel, personalWorkspace, type TestAccount } from "./helpers";

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

type JobBody = { job: { id: number; channel_ids: string[]; project_id: string } };

async function addProject(name: string): Promise<string> {
  const res = await post("/api/projects", { name });
  return ((await res.json()) as { project: { id: string } }).project.id;
}

describe("jobs and alert channels", () => {
  it("refuses notify_targets and points to channels", async () => {
    for (const res of [
      await post("/api/jobs", { ...BASE_JOB, notify_targets: [{ type: "slack", url: "https://hooks.slack.com/x" }] }),
      await post("/api/jobs", { ...BASE_JOB, notify_targets: null }),
    ]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/channel_ids.*\/api\/channels|\/api\/channels.*channel_ids/);
    }
    const created = (await (await post("/api/jobs", BASE_JOB)).json()) as JobBody;
    const res = await patch(`/api/jobs/${created.job.id}`, { notify_targets: [] });
    expect(res.status).toBe(400);
    expect(created.job).not.toHaveProperty("notify_targets");
  });

  it("gives a new job the enabled default channels of its project", async () => {
    const { workspaceId, projectId } = await personalWorkspace(account);
    const other = await addProject("Other");
    const wide = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/a" }, { autoEnable: true });
    const own = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/b" }, { autoEnable: true, projectId });
    await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/c" }, { autoEnable: true, projectId: other });
    await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/d" }, { autoEnable: true, enabled: false });
    await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/e" });
    const { job } = (await (await post("/api/jobs", { ...BASE_JOB, project_id: projectId })).json()) as JobBody;
    expect(job.channel_ids.sort()).toEqual([wide, own].sort());
    const none = (await (await post("/api/jobs", { ...BASE_JOB, project_id: projectId, channel_ids: [] })).json()) as JobBody;
    expect(none.job.channel_ids).toEqual([]);
  });

  it("accepts only channels of the workspace that fit the job's project", async () => {
    const { workspaceId, projectId } = await personalWorkspace(account);
    const other = await addProject("Other");
    const foreign = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/c" }, { projectId: other });
    const fits = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/a" }, { projectId });
    expect((await post("/api/jobs", { ...BASE_JOB, project_id: projectId, channel_ids: [foreign] })).status).toBe(400);
    expect((await post("/api/jobs", { ...BASE_JOB, project_id: projectId, channel_ids: ["ch_nope"] })).status).toBe(400);
    expect((await post("/api/jobs", { ...BASE_JOB, project_id: projectId, channel_ids: "x" })).status).toBe(400);
    const res = await post("/api/jobs", { ...BASE_JOB, project_id: projectId, channel_ids: [fits, fits] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as JobBody).job.channel_ids).toEqual([fits]);
  });

  it("replaces, keeps and clears a job's channels on PATCH", async () => {
    const { workspaceId, projectId } = await personalWorkspace(account);
    const a = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/a" });
    const b = await insertChannel(workspaceId, { type: "discord", url: "https://discord.com/api/webhooks/b" });
    const { job } = (await (await post("/api/jobs", { ...BASE_JOB, project_id: projectId, channel_ids: [a] })).json()) as JobBody;
    let res = (await (await patch(`/api/jobs/${job.id}`, { name: "renamed" })).json()) as JobBody;
    expect(res.job.channel_ids).toEqual([a]);
    res = (await (await patch(`/api/jobs/${job.id}`, { channel_ids: [b] })).json()) as JobBody;
    expect(res.job.channel_ids).toEqual([b]);
    res = (await (await patch(`/api/jobs/${job.id}`, { channel_ids: [] })).json()) as JobBody;
    expect(res.job.channel_ids).toEqual([]);
    const listed = (await (await SELF.fetch("https://w/api/jobs", { headers: auth() })).json()) as { jobs: JobBody["job"][] };
    expect(listed.jobs[0]!.channel_ids).toEqual([]);
  });

  it("drops channels of the old project when a job moves", async () => {
    const { workspaceId, projectId } = await personalWorkspace(account);
    const other = await addProject("Other");
    const wide = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/a" });
    const own = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/b" }, { projectId });
    const { job } = (await (await post("/api/jobs", { ...BASE_JOB, project_id: projectId, channel_ids: [wide, own] })).json()) as JobBody;
    const moved = (await (await patch(`/api/jobs/${job.id}`, { project_id: other })).json()) as JobBody;
    expect(moved.job.channel_ids).toEqual([wide]);
  });

  it("sends a failed manual run to the job's channels", async () => {
    const { workspaceId, projectId } = await personalWorkspace(account);
    let alerted = 0;
    fetchMock.get("https://example.test").intercept({ path: "/bad" }).reply(500, "oops");
    fetchMock.get("https://hooks.slack.com").intercept({ path: "/manual", method: "POST" }).reply(200, () => { alerted++; return "ok"; });
    const channel = await insertChannel(workspaceId, { type: "slack", url: "https://hooks.slack.com/manual" });
    const created = await post("/api/jobs", { ...BASE_JOB, project_id: projectId, url: "https://example.test/bad", channel_ids: [channel] });
    const { job } = (await created.json()) as JobBody;
    const res = await post(`/api/jobs/${job.id}/run`, {});
    expect(res.status).toBe(200);
    expect(alerted).toBe(1);
  });
});

describe("POST /api/jobs — workspace limit", () => {
  it("refuses a job past the per-workspace limit", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { workspaceId, projectId } = await personalWorkspace(account);
    const insert = env.DB.prepare(
      `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at, created_at, updated_at, owner_user_id, organization_id, project_id)
       VALUES ('j', 'https://example.com', 'GET', '0 12 * * *', 0, 30000, ?, ?, ?, ?, ?, ?)`,
    );
    await env.DB.batch(Array.from({ length: 200 }, () => insert.bind(now, now, now, account.userId, workspaceId, projectId)));
    const res = await post("/api/jobs", BASE_JOB);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/at most 200 jobs/);
  });
});
