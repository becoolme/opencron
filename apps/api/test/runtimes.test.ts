import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import type { Env, JobRow } from "../src/types";
import { runScriptJob } from "../src/script-runner";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let account: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  account = await createTestAccount("runtimes");
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
beforeEach(async () => { await clearDb(); });

const job = (partial: Partial<JobRow>): JobRow => ({
  id: 7, name: "py", url: null, method: "GET", headers: null, body: null, cron: "0 12 * * *", enabled: 1,
  timeout_ms: 5000, next_run_at: 0, last_run_at: null, last_status: null, type: "script", runtime: "python",
  script: "print('hi')", script_version: 1, owner_user_id: account.userId, notify_on: null, notify_channels: null,
  created_at: 0, updated_at: 0, ...partial,
} as JobRow);

const sandboxEnv = { ...env, LOADER: undefined, SANDBOX_URL: "https://sandbox.internal", SANDBOX_TOKEN: "test-sandbox-token-0123456789" } as Env;

describe("script runtimes on Cloudflare", () => {
  it("only offers JavaScript", async () => {
    const res = await SELF.fetch("https://w/api/meta", { headers: account.headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runtimes: ["javascript"] });
  });

  it("refuses Python and Go jobs", async () => {
    for (const runtime of ["python", "go"]) {
      const res = await SELF.fetch("https://w/api/jobs", {
        method: "POST", headers: account.headers,
        body: JSON.stringify({ name: "x", type: "script", runtime, script: "print(1)", cron: "0 12 * * *" }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("refuses a runtime on URL jobs", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: account.headers,
      body: JSON.stringify({ name: "x", url: "https://example.com", runtime: "javascript", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("fails a Python run when no sandbox is configured", async () => {
    const result = await runScriptJob({ ...env, SANDBOX_URL: undefined } as Env, job({}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot run python/);
  });
});

describe("script runs in the Docker sandbox", () => {
  it("sends the script with the token and records stdout", async () => {
    let sent: { runtime: string; source: string; timeout_ms: number } | undefined;
    fetchMock.get("https://sandbox.internal").intercept({
      path: "/run", method: "POST",
      headers: { authorization: "Bearer test-sandbox-token-0123456789" },
    }).reply(200, (request) => {
      sent = JSON.parse(String(request.body));
      return { exit_code: 0, stdout: "hi\n", stderr: "", timed_out: false, duration_ms: 40 };
    });
    const result = await runScriptJob(sandboxEnv, job({}));
    expect(sent).toMatchObject({ runtime: "python", source: "print('hi')", timeout_ms: 5000 });
    expect(result).toMatchObject({ ok: true, status_code: null, response_snippet: "hi\n", error: null });
  });

  it("reports stderr when the script exits non-zero", async () => {
    fetchMock.get("https://sandbox.internal").intercept({ path: "/run", method: "POST" })
      .reply(200, { exit_code: 1, stdout: "", stderr: "Traceback: boom", timed_out: false, duration_ms: 12 });
    const result = await runScriptJob(sandboxEnv, job({}));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("reports a timeout", async () => {
    fetchMock.get("https://sandbox.internal").intercept({ path: "/run", method: "POST" })
      .reply(200, { exit_code: 137, stdout: "", stderr: "", timed_out: true, duration_ms: 5000 });
    const result = await runScriptJob(sandboxEnv, job({ runtime: "go", script: "package main" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Timed out after 5000 ms/);
  });

  it("fails the run when the sandbox refuses it", async () => {
    fetchMock.get("https://sandbox.internal").intercept({ path: "/run", method: "POST" })
      .reply(429, { error: "Sandbox is busy" });
    const result = await runScriptJob(sandboxEnv, job({}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/busy/);
  });
});
