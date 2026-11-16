import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { hashApiKey } from "../src/api-keys";
import { TOOLS } from "../src/mcp";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let alice: TestAccount;
let bob: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  alice = await createTestAccount("keys-alice");
  bob = await createTestAccount("keys-bob");
});
beforeEach(async () => { await clearDb(); });

async function createKey(account: TestAccount, scope: "read" | "write", name = `${scope} key`) {
  const res = await SELF.fetch("https://w/api/keys", { method: "POST", headers: account.headers, body: JSON.stringify({ name, scope }) });
  expect(res.status).toBe(201);
  return await res.json() as { key: { id: string; prefix: string; scope: string }; token: string };
}
const withKey = (token: string, init: RequestInit = {}, header: "bearer" | "x-api-key" = "bearer") => ({
  ...init,
  headers: { "content-type": "application/json", ...(header === "bearer" ? { authorization: `Bearer ${token}` } : { "x-api-key": token }) },
});
const newJob = { name: "ping", cron: "*/5 * * * *", url: "https://example.com/ping" };

describe("API keys", () => {
  it("are shown once and stored only as a hash", async () => {
    const { key, token } = await createKey(alice, "read");
    expect(token).toMatch(/^oc_[A-Za-z0-9_-]{32}$/);
    expect(key.prefix).toBe(token.slice(0, 7));
    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(key.id).first<Record<string, unknown>>();
    expect(row?.key_hash).toBe(await hashApiKey(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const listed = await (await SELF.fetch("https://w/api/keys", { headers: alice.headers })).json() as { keys: Record<string, unknown>[] };
    expect(listed.keys).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token.slice(7));
  });

  it("sign in as their owner, by bearer token or x-api-key", async () => {
    await SELF.fetch("https://w/api/jobs", { method: "POST", headers: alice.headers, body: JSON.stringify(newJob) });
    const { token } = await createKey(alice, "read");
    for (const header of ["bearer", "x-api-key"] as const) {
      const res = await SELF.fetch("https://w/api/jobs", withKey(token, {}, header));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);
    }
    const bobs = await createKey(bob, "read");
    expect(((await (await SELF.fetch("https://w/api/jobs", withKey(bobs.token))).json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("record when they were last used", async () => {
    const { key, token } = await createKey(alice, "read");
    await SELF.fetch("https://w/api/meta", withKey(token));
    const row = await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").bind(key.id).first<{ last_used_at: number }>();
    expect(row?.last_used_at).toBeGreaterThan(0);
  });

  it("refuse unknown, malformed and revoked keys", async () => {
    const { key, token } = await createKey(alice, "write");
    for (const bad of [`${token.slice(0, -1)}x`, "oc_short", `${token}x`]) {
      expect((await SELF.fetch("https://w/api/jobs", withKey(bad))).status).toBe(401);
    }
    expect((await SELF.fetch(`https://w/api/keys/${key.id}`, { method: "DELETE", headers: alice.headers })).status).toBe(204);
    expect((await SELF.fetch("https://w/api/jobs", withKey(token))).status).toBe(401);
  });

  it("with read scope can only read", async () => {
    const { token } = await createKey(alice, "read");
    expect((await SELF.fetch("https://w/api/jobs", withKey(token))).status).toBe(200);
    const res = await SELF.fetch("https://w/api/jobs", withKey(token, { method: "POST", body: JSON.stringify(newJob) }));
    expect(res.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n).toBe(0);
    expect((await SELF.fetch("https://w/api/secrets/API_TOKEN", withKey(token, { method: "PUT", body: JSON.stringify({ value: "x" }) }))).status).toBe(403);
  });

  it("with read scope do not see request or alert credentials", async () => {
    const created = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: alice.headers,
      body: JSON.stringify({
        ...newJob, headers: { Authorization: "Bearer req-token" }, method: "POST", body: "{\"k\":\"v\"}",
        notify_targets: [
          { type: "slack", url: "https://hooks.slack.com/services/T/B/hook-secret" },
          { type: "telegram", bot_token: "123:bot-secret", chat_id: "42" },
          { type: "lark", url: "https://open.feishu.cn/hook/lark-secret", sign_secret: "sign-secret" },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const { token } = await createKey(alice, "read");
    const text = await (await SELF.fetch("https://w/api/jobs", withKey(token))).text();
    for (const secret of ["req-token", "hook-secret", "bot-secret", "lark-secret", "sign-secret", "\\\"v\\\""]) expect(text).not.toContain(secret);
    expect(text).toContain("https://hooks.slack.com/***");
    expect(text).toContain("\"chat_id\":\"42\"");
    const own = await (await SELF.fetch("https://w/api/jobs", { headers: alice.headers })).text();
    expect(own).toContain("hook-secret");
  });

  it("with write scope can change jobs and secrets", async () => {
    const { token } = await createKey(alice, "write");
    const res = await SELF.fetch("https://w/api/jobs", withKey(token, { method: "POST", body: JSON.stringify(newJob) }));
    expect(res.status).toBe(201);
    const { job } = await res.json() as { job: { id: number } };
    expect((await SELF.fetch(`https://w/api/jobs/${job.id}`, withKey(token, { method: "PATCH", body: JSON.stringify({ enabled: false }) }))).status).toBe(200);
    expect((await SELF.fetch("https://w/api/secrets/API_TOKEN", withKey(token, { method: "PUT", body: JSON.stringify({ value: "s3cret" }) }))).status).toBe(201);
  });

  it("cannot manage keys, even with write scope", async () => {
    const { key, token } = await createKey(alice, "write");
    expect((await SELF.fetch("https://w/api/keys", withKey(token))).status).toBe(403);
    expect((await SELF.fetch("https://w/api/keys", withKey(token, { method: "POST", body: JSON.stringify({ name: "x", scope: "write" }) }))).status).toBe(403);
    expect((await SELF.fetch(`https://w/api/keys/${key.id}`, withKey(token, { method: "DELETE" }))).status).toBe(403);
  });

  it("validate the name and scope, and belong to one account", async () => {
    const post = (body: unknown) => SELF.fetch("https://w/api/keys", { method: "POST", headers: alice.headers, body: JSON.stringify(body) });
    expect((await post({ name: "" })).status).toBe(400);
    expect((await post({ name: "x".repeat(61) })).status).toBe(400);
    expect((await post({ name: "x", scope: "admin" })).status).toBe(400);
    const { key } = await createKey(alice, "read");
    expect((await SELF.fetch(`https://w/api/keys/${key.id}`, { method: "DELETE", headers: bob.headers })).status).toBe(404);
    expect((await SELF.fetch("https://w/api/keys", { headers: bob.headers }).then((r) => r.json()) as { keys: unknown[] }).keys).toHaveLength(0);
  });

  it("are limited to 20 per account", async () => {
    for (let i = 0; i < 20; i++) await createKey(alice, "read", `k${i}`);
    const res = await SELF.fetch("https://w/api/keys", { method: "POST", headers: alice.headers, body: JSON.stringify({ name: "one more" }) });
    expect(res.status).toBe(400);
  });
});

describe("the MCP endpoint", () => {
  const rpc = (body: unknown, headers: Record<string, string>) => SELF.fetch("https://w/api/mcp", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const text = async (res: Response) => {
    const body = await res.json() as { result: { isError: boolean; content: { text: string }[] } };
    return { isError: body.result.isError, value: JSON.parse(body.result.content[0].text) };
  };

  it("needs credentials", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
    expect(res.status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer("oc_" + "a".repeat(32)))).status).toBe(401);
  });

  it("initializes and lists its tools", async () => {
    const { token } = await createKey(alice, "read");
    const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, bearer(token))).json() as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("opencron");
    const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer(token))).json() as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(list.result.tools.find((tool) => tool.name === "list_jobs")?.annotations.readOnlyHint).toBe(true);
  });

  it("creates, reads and pauses a job with a write key", async () => {
    const { token } = await createKey(alice, "write");
    const created = await text(await rpc(call("create_job", newJob), bearer(token)));
    expect(created.isError).toBe(false);
    const jobId = created.value.job.id as number;
    expect((await text(await rpc(call("pause_job", { id: jobId }), bearer(token)))).value.job.enabled).toBe(false);
    const listed = await text(await rpc(call("list_jobs", {}), bearer(token)));
    expect(listed.value.jobs.map((job: { id: number }) => job.id)).toEqual([jobId]);
    const secret = await text(await rpc(call("set_secret", { name: "API_TOKEN", value: "s3cret" }), bearer(token)));
    expect(secret.isError).toBe(false);
    expect(JSON.stringify((await text(await rpc(call("list_secrets", {}), bearer(token)))).value)).not.toContain("s3cret");
  });

  it("reports a write refused for a read key as a tool error", async () => {
    const { token } = await createKey(alice, "read");
    const result = await text(await rpc(call("create_job", newJob), bearer(token)));
    expect(result.isError).toBe(true);
    expect(result.value.error).toMatch(/read-only/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n).toBe(0);
  });

  it("rejects invalid arguments before calling the API", async () => {
    const { token } = await createKey(alice, "write");
    const res = await (await rpc(call("set_secret", { name: "path", value: "x" }), bearer(token))).json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Invalid arguments/);
  });

  it("drops the session cookie of a request from another site", async () => {
    const res = await rpc(call("list_jobs", {}), { ...alice.headers, origin: "https://evil.example" });
    expect(res.status).toBe(401);
    const same = await rpc(call("list_jobs", {}), { ...alice.headers, origin: "https://w" });
    expect(same.status).toBe(200);
  });
});
