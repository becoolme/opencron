import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import type { Env, JobRow } from "../src/types";
import type { WorkerCode, WorkerLoader } from "../src/loader-types";
import { buildWorkerCode, runScriptJob } from "../src/script-runner";
import { decryptSecret, encryptSecret, maskSecrets, secretNameProblem } from "../src/secrets";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let alice: TestAccount;
let bob: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  alice = await createTestAccount("secrets-alice");
  bob = await createTestAccount("secrets-bob");
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
beforeEach(async () => { await clearDb(); });

const put = (account: TestAccount, name: string, body: unknown) => SELF.fetch(`https://w/api/secrets/${name}`, {
  method: "PUT", headers: account.headers, body: JSON.stringify(body),
});
const list = async (account: TestAccount) =>
  (await (await SELF.fetch("https://w/api/secrets", { headers: account.headers })).json() as { secrets: Record<string, unknown>[] }).secrets;

const job = (partial: Partial<JobRow>): JobRow => ({
  id: 9, name: "s", url: null, method: "GET", headers: null, body: null, cron: "0 12 * * *", enabled: 1,
  timeout_ms: 5000, next_run_at: 0, last_run_at: null, last_status: null, type: "script", runtime: "python",
  script: "print('hi')", script_version: 3, owner_user_id: alice.userId, notify_targets: null, last_notified_at: null,
  created_at: 0, updated_at: 0, ...partial,
} as JobRow);

describe("the secrets API", () => {
  it("needs a session", async () => {
    expect((await SELF.fetch("https://w/api/secrets")).status).toBe(401);
  });

  it("stores a secret and never returns its value", async () => {
    const res = await put(alice, "API_TOKEN", { value: "tok-123456", note: "for the weather API" });
    expect(res.status).toBe(201);
    const body = await res.json() as { secret: Record<string, unknown> };
    expect(body.secret).toMatchObject({ name: "API_TOKEN", note: "for the weather API" });
    expect(JSON.stringify(body)).not.toContain("tok-123456");

    const secrets = await list(alice);
    expect(secrets.map((secret) => secret.name)).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(secrets)).not.toContain("tok-123456");
  });

  it("keeps values encrypted at rest", async () => {
    await put(alice, "API_TOKEN", { value: "tok-123456" });
    const row = await env.DB.prepare("SELECT value FROM secrets WHERE name = 'API_TOKEN'").first<{ value: string }>();
    expect(row!.value).toMatch(/^v1:/);
    expect(row!.value).not.toContain("tok-123456");
    expect(await decryptSecret(env, alice.userId, "API_TOKEN", row!.value)).toBe("tok-123456");
    // bound to its owner and name: copied to another row it does not decrypt
    await expect(decryptSecret(env, bob.userId, "API_TOKEN", row!.value)).rejects.toThrow();
    await expect(decryptSecret(env, alice.userId, "OTHER", row!.value)).rejects.toThrow();
  });

  it("replaces a value, and updates only the note when the value is left out", async () => {
    await put(alice, "API_TOKEN", { value: "first-value", note: "a" });
    expect((await put(alice, "API_TOKEN", { value: "second-value" })).status).toBe(200);
    expect((await list(alice))[0]).toMatchObject({ note: "a" });
    expect((await put(alice, "API_TOKEN", { note: "b" })).status).toBe(200);
    const row = await env.DB.prepare("SELECT value, note FROM secrets WHERE name = 'API_TOKEN'").first<{ value: string; note: string }>();
    expect(row!.note).toBe("b");
    expect(await decryptSecret(env, alice.userId, "API_TOKEN", row!.value)).toBe("second-value");
    expect((await put(alice, "NEW_ONE", { note: "no value" })).status).toBe(400);
  });

  it("refuses bad names and values", async () => {
    for (const name of ["lower", "1ABC", "PATH", "NODE_OPTIONS", "OPENCRON_X", "LD_PRELOAD", "HTTPS_PROXY", "KV"]) {
      expect((await put(alice, name, { value: "x" })).status, name).toBe(400);
    }
    expect((await put(alice, "EMPTY", { value: "" })).status).toBe(400);
    expect((await put(alice, "NUM", { value: 5 })).status).toBe(400);
    expect((await put(alice, "BIG", { value: "x".repeat(16 * 1024 + 1) })).status).toBe(400);
    expect(await list(alice)).toEqual([]);
  });

  it("limits the total size of an account's secrets", async () => {
    for (let i = 0; i < 4; i++) expect((await put(alice, `PART_${i}`, { value: "x".repeat(16 * 1024) })).status).toBe(201);
    expect((await put(alice, "ONE_MORE", { value: "x" })).status).toBe(400);
    // replacing one of them with a value of the same size still fits
    expect((await put(alice, "PART_0", { value: "y".repeat(16 * 1024) })).status).toBe(200);
  });

  it("keeps accounts apart", async () => {
    await put(alice, "API_TOKEN", { value: "alice-value" });
    expect(await list(bob)).toEqual([]);
    expect((await SELF.fetch("https://w/api/secrets/API_TOKEN", { method: "DELETE", headers: bob.headers })).status).toBe(404);
    expect((await SELF.fetch("https://w/api/secrets/API_TOKEN", { method: "DELETE", headers: alice.headers })).status).toBe(204);
    expect(await list(alice)).toEqual([]);
  });
});

describe("secrets in script runs", () => {
  it("reaches a Cloudflare script as env.NAME, next to the storage bindings", () => {
    const code = buildWorkerCode(env, "export default {}", undefined, undefined, { API_TOKEN: "tok" });
    expect(code.env).toEqual({ API_TOKEN: "tok" });
  });

  it("starts a fresh isolate when a secret changes", async () => {
    const ids: string[] = [];
    const codes: WorkerCode[] = [];
    const loader: WorkerLoader = {
      get(id, factory) {
        ids.push(id);
        return {
          getEntrypoint: () => ({
            fetch: async () => {
              codes.push(await factory());
              return new Response("ok");
            },
          }) as unknown as Fetcher,
        };
      },
      load: () => { throw new Error("unused"); },
    };
    const cfEnv = { ...env, LOADER: loader } as Env;
    const jsJob = job({ runtime: "javascript", script: "export default {}" });

    await runScriptJob(cfEnv, jsJob);
    await put(alice, "API_TOKEN", { value: "first-value" });
    await runScriptJob(cfEnv, jsJob);
    await put(alice, "API_TOKEN", { value: "second-value" });
    await runScriptJob(cfEnv, jsJob);

    expect(ids[0]).toBe("job-9-v3");
    expect(ids[1]).toMatch(/^job-9-v3-s[0-9a-f]{12}$/);
    expect(ids[2]).toMatch(/^job-9-v3-s[0-9a-f]{12}$/);
    expect(ids[2]).not.toBe(ids[1]);
    expect(codes[2].env).toMatchObject({ API_TOKEN: "second-value" });
  });

  it("are sent to the Docker sandbox and masked in the run history", async () => {
    await put(alice, "API_TOKEN", { value: "tok-abcdef" });
    await put(alice, "SHORT", { value: "ab" });
    let sent: { env?: Record<string, string> } | undefined;
    fetchMock.get("https://sandbox.internal").intercept({ path: "/run", method: "POST" }).reply(200, (request) => {
      sent = JSON.parse(String(request.body));
      return { exit_code: 1, stdout: "using tok-abcdef\n", stderr: "denied for tok-abcdef", timed_out: false, duration_ms: 5 };
    });
    const sandboxEnv = { ...env, LOADER: undefined, SANDBOX_URL: "https://sandbox.internal", SANDBOX_TOKEN: "test-sandbox-token-0123456789" } as Env;
    const result = await runScriptJob(sandboxEnv, job({}));
    expect(sent!.env).toEqual({ API_TOKEN: "tok-abcdef", SHORT: "ab" });
    expect(result.response_snippet).toBe("using ***\n");
    expect(result.error).toBe("denied for ***");
  });

  it("are masked before long output is cut to its last 500 characters", async () => {
    await put(alice, "API_TOKEN", { value: "tok-abcdef" });
    const padding = "x".repeat(495);
    fetchMock.get("https://sandbox.internal").intercept({ path: "/run", method: "POST" })
      .reply(200, { exit_code: 0, stdout: `tok-abcdef${padding}`, stderr: "", timed_out: false, duration_ms: 5 });
    const sandboxEnv = { ...env, LOADER: undefined, SANDBOX_URL: "https://sandbox.internal", SANDBOX_TOKEN: "test-sandbox-token-0123456789" } as Env;
    const result = await runScriptJob(sandboxEnv, job({}));
    expect(result.response_snippet).toBe(`***${padding}`);
  });

  it("fails the run with a clear message when a secret can no longer be decrypted", async () => {
    await put(alice, "API_TOKEN", { value: "tok-abcdef" });
    const rotated = { ...env, BETTER_AUTH_SECRET: "a-different-secret-after-rotation-0123456789", SANDBOX_URL: "https://sandbox.internal" } as Env;
    const result = await runScriptJob(rotated, job({}));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/API_TOKEN cannot be decrypted/);
  });
});

describe("secret helpers", () => {
  it("masks longer values first", () => {
    expect(maskSecrets("abcdef and abcd", { A: "abcd", B: "abcdef" })).toBe("*** and ***");
    expect(maskSecrets(null, { A: "abcd" })).toBeNull();
  });

  it("round-trips and binds a value", async () => {
    const sealed = await encryptSecret(env, "u", "N", "héllo ✓");
    expect(await decryptSecret(env, "u", "N", sealed)).toBe("héllo ✓");
    expect(secretNameProblem("GOOD_NAME")).toBeNull();
    expect(secretNameProblem("DOCKER_HOST")).toMatch(/reserved/);
  });
});
