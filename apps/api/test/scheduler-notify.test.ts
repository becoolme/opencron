import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { applyMigrations, clearDb, insertChannel, linkChannel } from "./helpers";
import type { NotifyTarget } from "../src/types";
import { dispatchDueJobs } from "../src/scheduler";

beforeAll(async () => {
  await applyMigrations();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
const WORKSPACE = "ws_scheduler_notify";
beforeEach(async () => {
  await clearDb();
  await env.DB.prepare(`INSERT INTO organization (id, name, slug, "createdAt") VALUES (?, 'n', 'ws-scheduler-notify', ?)`)
    .bind(WORKSPACE, new Date().toISOString()).run();
});

async function insertFailingJob(targets: NotifyTarget[]) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at,
                       created_at, updated_at, organization_id)
     VALUES ('j', 'https://example.test/bad', 'GET', '* * * * *', 1, 30000, ?, ?, ?, ?)`,
  ).bind(now - 10, now, now, WORKSPACE).run();
  const id = (await env.DB.prepare("SELECT id FROM jobs ORDER BY id DESC LIMIT 1").first<{ id: number }>())!.id;
  for (const target of targets) await linkChannel(id, await insertChannel(WORKSPACE, target));
  return id;
}

describe("scheduler + notify", () => {
  it("fires webhook on failed execution", async () => {
    fetchMock.get("https://example.test").intercept({ path: "/bad" }).reply(500, "oops");
    fetchMock.get("https://hooks.slack.com").intercept({ path: "/xxx", method: "POST" }).reply(200, "ok");

    const id = await insertFailingJob([{ type: "slack", url: "https://hooks.slack.com/xxx" }]);
    await dispatchDueJobs(env);

    const row = await env.DB.prepare("SELECT last_notified_at FROM jobs WHERE id = ?").bind(id).first<{ last_notified_at: number }>();
    expect(row!.last_notified_at).not.toBeNull();
  });

  it("does not fire webhook on successful execution", async () => {
    fetchMock.get("https://example.test").intercept({ path: "/bad" }).reply(200, "yes");
    const id = await insertFailingJob([{ type: "slack", url: "https://hooks.slack.com/xxx" }]);
    const spy = vi.spyOn(globalThis, "fetch");

    await dispatchDueJobs(env);

    // Only the job's own fetch ran; the slack webhook was not called.
    const slackCalls = spy.mock.calls.filter((c) => String(c[0]).startsWith("https://hooks.slack.com"));
    expect(slackCalls).toHaveLength(0);

    const row = await env.DB.prepare("SELECT last_notified_at FROM jobs WHERE id = ?").bind(id).first<{ last_notified_at: number }>();
    expect(row!.last_notified_at).toBeNull();
    spy.mockRestore();
  });
});
