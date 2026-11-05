import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchMock, SELF } from "cloudflare:test";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let account: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  account = await createTestAccount("script-jobs");
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
beforeEach(async () => { await clearDb(); });

const auth = (): Record<string, string> => account.headers;

describe("POST /api/jobs type=script", () => {
  it("creates a script job and returns type/script/script_version in the DTO", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({
        name: "calc",
        type: "script",
        script: "export default { fetch() { return new Response('hi') } }",
        cron: "0 12 * * *",
        timeout_ms: 5000,
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { job: { type: string; script: string; script_version: number; url: string | null } };
    expect(json.job.type).toBe("script");
    expect(json.job.script_version).toBe(1);
    expect(json.job.script).toContain("Response('hi')");
    expect(json.job.url).toBeNull();
  });

  it("rejects type=script when script is missing", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "x", type: "script", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/script/i);
  });

  it("rejects type=script when script is an empty string", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "x", type: "script", script: "", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects type=script when url is also provided", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "x", type: "script", script: "export default { fetch(){} }", url: "https://a.b", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects type=url when script is provided", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "x", type: "url", url: "https://a.b", script: "x", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("defaults to type=url when type is omitted (backwards compatible)", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "x", url: "https://a.b", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { job: { type: string } };
    expect(json.job.type).toBe("url");
  });

  it("rejects unknown type values", async () => {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "x", type: "wasm", script: "x", cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/jobs/:id for script jobs", () => {
  async function createScriptJob(script: string): Promise<number> {
    const res = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "s", type: "script", script, cron: "0 12 * * *" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { job: { id: number } }).job.id;
  }

  it("bumps script_version when the script changes", async () => {
    const id = await createScriptJob("export default { fetch() { return new Response('v1') } }");
    const res = await SELF.fetch("https://w/api/jobs/" + id, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ script: "export default { fetch() { return new Response('v2') } }" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { job: { script: string; script_version: number } };
    expect(json.job.script_version).toBe(2);
    expect(json.job.script).toContain("'v2'");
  });

  it("does not bump script_version when only name/cron/enabled change", async () => {
    const id = await createScriptJob("export default { fetch() { return new Response('v1') } }");
    const res = await SELF.fetch("https://w/api/jobs/" + id, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ name: "renamed", cron: "30 12 * * *" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { job: { script_version: number; name: string } };
    expect(json.job.script_version).toBe(1);
    expect(json.job.name).toBe("renamed");
  });

  it("does not bump script_version when the patched script is identical", async () => {
    const src = "export default { fetch() { return new Response('same') } }";
    const id = await createScriptJob(src);
    const res = await SELF.fetch("https://w/api/jobs/" + id, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ script: src }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { job: { script_version: number } };
    expect(json.job.script_version).toBe(1);
  });

  it("rejects attempts to change type", async () => {
    const id = await createScriptJob("export default { fetch(){} }");
    const res = await SELF.fetch("https://w/api/jobs/" + id, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ type: "url", url: "https://a.b" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects setting url on a script job", async () => {
    const id = await createScriptJob("export default { fetch(){} }");
    const res = await SELF.fetch("https://w/api/jobs/" + id, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ url: "https://a.b" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects setting script on a url job", async () => {
    const create = await SELF.fetch("https://w/api/jobs", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ name: "u", url: "https://a.b", cron: "0 12 * * *" }),
    });
    const id = ((await create.json()) as { job: { id: number } }).job.id;
    const res = await SELF.fetch("https://w/api/jobs/" + id, {
      method: "PATCH", headers: auth(),
      body: JSON.stringify({ script: "x" }),
    });
    expect(res.status).toBe(400);
  });
});
