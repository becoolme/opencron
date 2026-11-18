import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { migrateInlineTargets, resetChannelMigration } from "../src/channel-migration";
import { openConfig } from "../src/channels";
import { applyMigrations, clearDb, createTestAccount, insertChannel, type TestAccount } from "./helpers";

let owner: TestAccount;
let member: TestAccount;

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await applyMigrations();
  owner = await createTestAccount("ch-owner");
  member = await createTestAccount("ch-member");
});
afterAll(() => fetchMock.deactivate());
beforeEach(async () => { await clearDb(); });

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
async function call(account: TestAccount, path: string, init: Init = {}) {
  const response = await SELF.fetch(`https://w${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...account.headers, ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

/** A workspace owned by `owner` with `member` joined as a member. */
async function team() {
  const created = await call(owner, "/api/workspaces", { body: { name: "Team" } });
  const workspaceId = created.body.workspace.id as string;
  const scope = { "x-workspace-id": workspaceId };
  const invite = await call(owner, "/api/invitations", { body: { email: member.email, role: "member" }, headers: scope });
  expect((await call(member, `/api/invite/${invite.body.invitation.id}/accept`, { body: {} })).status).toBe(200);
  const projects = await call(owner, "/api/projects", { headers: scope });
  return { workspaceId, scope, projectId: projects.body.projects[0].id as string };
}

const SLACK = { type: "slack", name: "Ops", config: { url: "https://hooks.slack.com/services/T000/B000/secretvalue1234" } };

describe("alert channels", () => {
  it("lets members list masked channels but not change them", async () => {
    const { scope } = await team();
    const created = await call(owner, "/api/channels", { body: SLACK, headers: scope });
    expect(created.status).toBe(201);
    const id = created.body.channel.id as string;
    expect(created.body.channel.config.url).toBe("https://hooks.slack.com/…1234");

    const listed = await call(member, "/api/channels", { headers: scope });
    expect(listed.status).toBe(200);
    expect(listed.body.channels).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain("secretvalue");
    expect(listed.body.types).toContain("telegram");

    expect((await call(member, "/api/channels", { body: SLACK, headers: scope })).status).toBe(403);
    expect((await call(member, `/api/channels/${id}`, { method: "PATCH", body: { name: "x" }, headers: scope })).status).toBe(403);
    expect((await call(member, `/api/channels/${id}`, { method: "DELETE", headers: scope })).status).toBe(403);
    expect((await call(member, `/api/channels/${id}/test`, { body: {}, headers: scope })).status).toBe(403);
  });

  it("validates new channels", async () => {
    const { scope } = await team();
    expect((await call(owner, "/api/channels", { body: { ...SLACK, type: "pager" }, headers: scope })).status).toBe(400);
    expect((await call(owner, "/api/channels", { body: { ...SLACK, name: " " }, headers: scope })).status).toBe(400);
    expect((await call(owner, "/api/channels", { body: { ...SLACK, config: { url: "http://hooks.slack.com/x" } }, headers: scope })).status).toBe(400);
    expect((await call(owner, "/api/channels", { body: { ...SLACK, project_id: "pj_other" }, headers: scope })).status).toBe(400);
    const http = await call(owner, "/api/channels", {
      body: { type: "http", name: "Hook", config: { url: "http://example.com/hook", headers: { Authorization: "Bearer abc" } } },
      headers: scope,
    });
    expect(http.status).toBe(201);
    expect(http.body.channel.config.headers).toEqual({ Authorization: "***" });
  });

  it("keeps saved secrets when the form sends them back masked or empty", async () => {
    const { scope } = await team();
    const created = await call(owner, "/api/channels", {
      body: { type: "lark", name: "Lark", config: { url: "https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh1234", sign_secret: "s3cret" } },
      headers: scope,
    });
    const id = created.body.channel.id as string;
    const shown = created.body.channel.config;
    expect(shown.sign_secret).toBe("***");

    const renamed = await call(owner, `/api/channels/${id}`, { method: "PATCH", body: { name: "Feishu", config: shown }, headers: scope });
    expect(renamed.status).toBe(200);
    expect(renamed.body.channel.name).toBe("Feishu");
    const row = await env.DB.prepare("SELECT config FROM alert_channels WHERE id = ?").bind(id).first<{ config: string }>();
    expect(await openConfig(env, id, row!.config)).toEqual({
      type: "lark", url: "https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh1234", sign_secret: "s3cret",
    });

    await call(owner, `/api/channels/${id}`, { method: "PATCH", body: { config: { url: "", sign_secret: null } }, headers: scope });
    const after = await env.DB.prepare("SELECT config FROM alert_channels WHERE id = ?").bind(id).first<{ config: string }>();
    expect(await openConfig(env, id, after!.config)).toEqual({ type: "lark", url: "https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh1234" });

    expect((await call(owner, `/api/channels/${id}`, { method: "PATCH", body: { type: "slack" }, headers: scope })).status).toBe(400);
  });

  it("sends a test alert", async () => {
    const { scope } = await team();
    const id = (await call(owner, "/api/channels", { body: SLACK, headers: scope })).body.channel.id as string;
    let body = "";
    fetchMock.get("https://hooks.slack.com").intercept({ path: "/services/T000/B000/secretvalue1234", method: "POST" })
      .reply(200, (request) => { body = String(request.body); return "ok"; });
    const sent = await call(owner, `/api/channels/${id}/test`, { body: {}, headers: scope });
    expect(sent.body).toEqual({ ok: true, error: null });
    expect(body).toContain("test alert");

    fetchMock.get("https://hooks.slack.com").intercept({ path: "/services/T000/B000/secretvalue1234", method: "POST" }).reply(500, "no");
    const failed = await call(owner, `/api/channels/${id}/test`, { body: {}, headers: scope });
    expect(failed.body.ok).toBe(false);
    expect(failed.body.error).toBeTruthy();
  });

  it("adds a channel to every job, and removes links when deleted", async () => {
    const { scope, projectId } = await team();
    const id = (await call(owner, "/api/channels", { body: SLACK, headers: scope })).body.channel.id as string;
    for (const name of ["a", "b"]) {
      await call(member, "/api/jobs", { body: { name, cron: "0 12 * * *", url: "https://example.com", channel_ids: [] }, headers: scope });
    }
    const applied = await call(owner, `/api/channels/${id}/apply-to-all`, { body: {}, headers: scope });
    expect(applied.body).toEqual({ added: 2 });
    expect((await call(owner, `/api/channels/${id}/apply-to-all`, { body: {}, headers: scope })).body).toEqual({ added: 0 });
    expect((await call(owner, `/api/channels/${id}`, { headers: scope })).body.channel.job_count).toBe(2);

    const other = (await call(owner, "/api/projects", { body: { name: "Other" }, headers: scope })).body.project.id as string;
    const moved = await call(owner, `/api/channels/${id}`, { method: "PATCH", body: { project_id: other }, headers: scope });
    expect(moved.body.channel.project_id).toBe(other);
    expect(moved.body.channel.job_count).toBe(0);

    await call(owner, `/api/channels/${id}`, { method: "PATCH", body: { project_id: null }, headers: scope });
    await call(owner, `/api/channels/${id}/apply-to-all`, { body: {}, headers: scope });
    expect((await call(owner, `/api/channels/${id}`, { method: "DELETE", headers: scope })).status).toBe(204);
    const links = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_channels").first<{ n: number }>();
    expect(links!.n).toBe(0);
    expect(projectId).toBeTruthy();
  });

  it("limits a workspace to 50 channels", async () => {
    const { workspaceId, scope } = await team();
    for (let i = 0; i < 50; i++) await insertChannel(workspaceId, { type: "slack", url: `https://hooks.slack.com/${i}` });
    expect((await call(owner, "/api/channels", { body: SLACK, headers: scope })).status).toBe(400);
  });
});

describe("moving inline alert targets into channels", () => {
  it("turns identical targets into one channel and clears the column", async () => {
    const { workspaceId, projectId } = await team();
    const slack = JSON.stringify([{ type: "slack", url: "https://hooks.slack.com/shared" }]);
    const both = JSON.stringify([{ url: "https://hooks.slack.com/shared", type: "slack" }, { type: "telegram", bot_token: "123:abc", chat_id: "42" }]);
    const insert = (name: string, targets: string) => env.DB.prepare(
      `INSERT INTO jobs (name, cron, url, method, organization_id, project_id, notify_targets, next_run_at, created_at, updated_at)
       VALUES (?, '0 12 * * *', 'https://example.com', 'GET', ?, ?, ?, 0, 0, 0) RETURNING id`,
    ).bind(name, workspaceId, projectId, targets).first<{ id: number }>();
    const first = await insert("first", slack);
    const second = await insert("second", both);
    await insert("broken", "not json");

    resetChannelMigration();
    await migrateInlineTargets(env);
    resetChannelMigration();
    await migrateInlineTargets(env);

    const channels = await env.DB.prepare("SELECT id, type, auto_enable, project_id FROM alert_channels ORDER BY type").all();
    expect(channels.results).toHaveLength(2);
    expect(channels.results.every((row) => row.auto_enable === 0 && row.project_id === null)).toBe(true);
    const links = await env.DB.prepare("SELECT job_id, channel_id FROM job_channels ORDER BY job_id").all<{ job_id: number; channel_id: string }>();
    expect(links.results.filter((row) => row.job_id === first!.id)).toHaveLength(1);
    expect(links.results.filter((row) => row.job_id === second!.id)).toHaveLength(2);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE notify_targets IS NOT NULL").first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
