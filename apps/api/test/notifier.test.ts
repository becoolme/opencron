import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { applyMigrations, clearDb, insertChannel, linkChannel } from "./helpers";
import { maybeNotify } from "../src/notifier";
import type { JobRow, NotifyTarget } from "../src/types";
import type { RunResult } from "../src/runner";

beforeAll(async () => {
  await applyMigrations();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
const WORKSPACE = "ws_notifier";
beforeEach(async () => {
  await clearDb();
  await env.DB.prepare(`INSERT INTO organization (id, name, slug, "createdAt") VALUES (?, 'n', 'ws-notifier', ?)`)
    .bind(WORKSPACE, new Date().toISOString()).run();
});
afterEach(() => { vi.restoreAllMocks(); });

/** A job with a channel for each target. */
async function insertJob(overrides: { targets?: NotifyTarget[]; last_notified_at?: number; disabled?: boolean } = {}): Promise<JobRow> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at,
                       created_at, updated_at, last_notified_at, organization_id)
     VALUES ('j', 'https://example.test/x', 'GET', '* * * * *', 1, 30000, ?, ?, ?, ?, ?)`,
  ).bind(now, now, now, overrides.last_notified_at ?? null, WORKSPACE).run();
  const row = (await env.DB.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 1").first<JobRow>())!;
  for (const target of overrides.targets ?? []) {
    await linkChannel(row.id, await insertChannel(WORKSPACE, target, { enabled: !overrides.disabled }));
  }
  return row;
}

const failedResult: RunResult = {
  started_at: 1776498572, duration_ms: 10, status_code: 500, ok: false, error: "boom", response_snippet: null,
};
const okResult: RunResult = { ...failedResult, ok: true, status_code: 200, error: null };

describe("maybeNotify", () => {
  it("does nothing when result.ok", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const job = await insertJob({ targets: [{ type: "slack", url: "https://hooks.slack.com/xxx" }] });
    await maybeNotify(env, job, okResult);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing when the job has no channels", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const job = await insertJob();
    await maybeNotify(env, job, failedResult);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing when inside 60s dedupe window", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const now = Math.floor(Date.now() / 1000);
    const job = await insertJob({
      targets: [{ type: "slack", url: "https://hooks.slack.com/xxx" }],
      last_notified_at: now - 30,
    });
    await maybeNotify(env, job, failedResult);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends and updates last_notified_at when outside dedupe window", async () => {
    fetchMock.get("https://hooks.slack.com").intercept({ path: "/xxx", method: "POST" }).reply(200, "ok");
    const job = await insertJob({
      targets: [{ type: "slack", url: "https://hooks.slack.com/xxx" }],
      last_notified_at: Math.floor(Date.now() / 1000) - 120,
    });
    await maybeNotify(env, job, failedResult);

    const row = await env.DB.prepare("SELECT last_notified_at FROM jobs WHERE id = ?").bind(job.id).first<{ last_notified_at: number }>();
    expect(row!.last_notified_at).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  it("fans out to multiple targets (Promise.allSettled)", async () => {
    fetchMock.get("https://hooks.slack.com").intercept({ path: "/xxx", method: "POST" }).reply(200, "ok");
    fetchMock.get("https://discord.com").intercept({ path: "/api/webhooks/AAA/BBB", method: "POST" }).reply(200, "ok");
    const spy = vi.spyOn(globalThis, "fetch");
    const job = await insertJob({
      targets: [
        { type: "slack", url: "https://hooks.slack.com/xxx" },
        { type: "discord", url: "https://discord.com/api/webhooks/AAA/BBB" },
      ],
    });
    await maybeNotify(env, job, failedResult);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("swallows adapter/fetch errors without throwing", async () => {
    fetchMock.get("https://hooks.slack.com").intercept({ path: "/xxx", method: "POST" }).reply(500, "bad");
    const job = await insertJob({
      targets: [{ type: "slack", url: "https://hooks.slack.com/xxx" }],
    });
    await expect(maybeNotify(env, job, failedResult)).resolves.toBeUndefined();
    // last_notified_at should still be updated (we tried)
    const row = await env.DB.prepare("SELECT last_notified_at FROM jobs WHERE id = ?").bind(job.id).first<{ last_notified_at: number }>();
    expect(row!.last_notified_at).not.toBeNull();
  });

  it("skips disabled channels", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const job = await insertJob({ targets: [{ type: "slack", url: "https://hooks.slack.com/xxx" }], disabled: true });
    await maybeNotify(env, job, failedResult);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips a channel whose settings no longer decrypt", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const job = await insertJob({ targets: [{ type: "slack", url: "https://hooks.slack.com/xxx" }] });
    await env.DB.prepare("UPDATE alert_channels SET config = 'v1:AAAA:AAAA'").run();
    await expect(maybeNotify(env, job, failedResult)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
