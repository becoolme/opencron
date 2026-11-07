import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import type { Env, JobRow } from "../src/types";
import { runScriptJob } from "../src/script-runner";
import { availableRuntimes } from "../src/runtimes";
import { sandboxRequestTarget } from "../src/sandbox-client";
import { makeLoaderMock } from "./utils/loader-mock";
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

describe("a sandbox next to the Cloudflare deployment", () => {
  const token = "test-sandbox-token-0123456789";

  it("offers every runtime once SANDBOX_URL is set", () => {
    expect(availableRuntimes({ SANDBOX_URL: undefined })).toEqual(["javascript"]);
    expect(availableRuntimes({ SANDBOX_URL: "https://sandbox.example.com" })).toEqual(["javascript", "python", "go"]);
  });

  it("keeps running JavaScript in the Worker Loader", async () => {
    // network is disabled: a request to the sandbox would fail the run
    const LOADER = makeLoaderMock({ "job-7-v1": async () => new Response("js", { status: 200 }) });
    const result = await runScriptJob({ ...sandboxEnv, LOADER } as unknown as Env, job({
      runtime: "javascript", script: "export default {}",
    }));
    expect(result).toMatchObject({ ok: true, status_code: 200, response_snippet: "js" });
  });

  it("sends a Cloudflare Access service token when one is set", async () => {
    fetchMock.get("https://sandbox.internal").intercept({
      path: "/run", method: "POST",
      headers: { "cf-access-client-id": "id.access", "cf-access-client-secret": "access-secret" },
    }).reply(200, { exit_code: 0, stdout: "ok", stderr: "", timed_out: false, duration_ms: 3 });
    const result = await runScriptJob({
      ...sandboxEnv, SANDBOX_ACCESS_CLIENT_ID: "id.access", SANDBOX_ACCESS_CLIENT_SECRET: "access-secret",
    } as Env, job({}));
    expect(result).toMatchObject({ ok: true, response_snippet: "ok" });
  });

  it("accepts plain HTTP only on a private network", () => {
    for (const url of ["http://sandbox:8787", "http://localhost:8787", "http://10.0.0.5:8787", "http://192.168.1.2"]) {
      expect(sandboxRequestTarget({ SANDBOX_URL: url, SANDBOX_TOKEN: token }).url.href).toBe(new URL("/run", url).href);
    }
    for (const url of ["http://sandbox.example.com", "http://203.0.113.9:8787", "ftp://sandbox.example.com"]) {
      expect(() => sandboxRequestTarget({ SANDBOX_URL: url, SANDBOX_TOKEN: token })).toThrow(/must use https/);
    }
  });

  it("refuses a run with an incomplete or placeholder configuration", async () => {
    expect(() => sandboxRequestTarget({ SANDBOX_URL: "https://s.example.com", SANDBOX_TOKEN: "change-me-sandbox-token" }))
      .toThrow(/placeholder/);
    expect(() => sandboxRequestTarget({ SANDBOX_URL: "not a url", SANDBOX_TOKEN: token })).toThrow(/valid URL/);
    expect(() => sandboxRequestTarget({ SANDBOX_URL: "https://s.example.com", SANDBOX_TOKEN: token, SANDBOX_ACCESS_CLIENT_ID: "id" }))
      .toThrow(/both/);
    const result = await runScriptJob({ ...sandboxEnv, SANDBOX_URL: "http://sandbox.example.com" } as Env, job({}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must use https/);
  });
});
