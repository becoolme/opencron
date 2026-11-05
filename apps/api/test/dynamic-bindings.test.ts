import { getDatabase } from "../src/database";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ScopedKvStorage, ScopedScriptRecords, ScopedScriptStorage } from "../src/dynamic-bindings";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let account: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  account = await createTestAccount("script-storage");
});

beforeEach(async () => {
  await clearDb();
});

async function createJob(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO jobs
       (name, url, method, cron, enabled, timeout_ms, next_run_at, created_at, updated_at, owner_user_id)
     VALUES ('storage-test', 'https://example.com', 'GET', '0 12 * * *', 1, 30000, ?, ?, ?, ?)
     RETURNING id`,
  ).bind(now, now, now, account.userId).first<{ id: number }>();
  return row!.id;
}

function storage(jobId: number): ScopedScriptStorage {
  return new ScopedScriptStorage(getDatabase(env), account.userId, jobId);
}

function records(jobId: number): ScopedScriptRecords {
  return new ScopedScriptRecords(getDatabase(env), account.userId, jobId);
}

function kv(jobId: number): ScopedKvStorage {
  return new ScopedKvStorage(env.SCRIPT_KV, account.userId, jobId);
}

describe("ScopedScriptStorage", () => {
  it("stores, lists, and deletes values within a job scope", async () => {
    const db = storage(await createJob());

    expect(await db.get("counter")).toBeNull();
    await db.put("counter", "1");
    await db.put("config/theme", "dark");
    expect(await db.get("counter")).toBe("1");
    expect(await db.list("config/")).toEqual([
      expect.objectContaining({ key: "config/theme", value: "dark" }),
    ]);

    await db.delete("counter");
    expect(await db.get("counter")).toBeNull();
  });

  it("does not expose values from another job", async () => {
    const first = storage(await createJob());
    const second = storage(await createJob());
    await first.put("shared-key", "private-value");

    expect(await second.get("shared-key")).toBeNull();
  });

  it("rejects oversized keys and values", async () => {
    const db = storage(await createJob());

    await expect(db.put("x".repeat(257), "value")).rejects.toThrow(/key/);
    await expect(db.put("你".repeat(86), "value")).rejects.toThrow(/key/);
    await expect(db.put("large", "x".repeat(100_001))).rejects.toThrow(/100 KB/);
  });
});

describe("ScopedScriptRecords", () => {
  it("lets a script create and update its string data records", async () => {
    const d1 = records(await createJob());

    const created = await d1.put("run/latest", "first value");
    expect(created).toMatchObject({ key: "run/latest", data: "first value" });

    const updated = await d1.put("run/latest", JSON.stringify({ ok: true }));
    expect(updated.data).toBe('{"ok":true}');
    expect((await d1.get("run/latest"))?.data).toBe('{"ok":true}');
    expect(await d1.list("run/")).toEqual([
      expect.objectContaining({ key: "run/latest", data: '{"ok":true}' }),
    ]);
  });

  it("injects ownership and does not expose another job's records", async () => {
    const firstJobId = await createJob();
    const secondJobId = await createJob();
    await records(firstJobId).put("private", "secret");

    expect(await records(secondJobId).get("private")).toBeNull();
    const stored = await env.DB.prepare(
      "SELECT owner_user_id, job_id, data FROM script_records WHERE record_key = 'private'",
    ).first<{ owner_user_id: string; job_id: number; data: string }>();
    expect(stored).toEqual({ owner_user_id: account.userId, job_id: firstJobId, data: "secret" });
  });

  it("only accepts bounded string data", async () => {
    const d1 = records(await createJob());

    await expect(d1.put("object", { unsafe: true } as unknown as string)).rejects.toThrow(/string/);
    await expect(d1.put("large", "x".repeat(100_001))).rejects.toThrow(/100 KB/);
  });
});

describe("ScopedKvStorage", () => {
  it("stores string values behind an invisible scope prefix", async () => {
    const jobId = await createJob();
    const store = kv(jobId);
    const key = `cache/${crypto.randomUUID()}`;

    await store.put(key, "cached value", { expirationTtl: 3600 });
    expect(await store.get(key)).toBe("cached value");
    expect((await store.list("cache/")).keys).toContainEqual(
      expect.objectContaining({ key }),
    );
    expect((await env.SCRIPT_KV.list({ prefix: "opencron:v1:" })).keys[0]?.name).toContain(
      `user:${account.userId}:job:${jobId}:`,
    );
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it("does not expose keys from another job", async () => {
    const first = kv(await createJob());
    const second = kv(await createJob());
    const key = `shared/${crypto.randomUUID()}`;
    await first.put(key, "private");

    expect(await second.get(key)).toBeNull();
    await first.delete(key);
  });

  it("validates values and expiration", async () => {
    const store = kv(await createJob());

    await expect(store.put("short-ttl", "x", { expirationTtl: 30 })).rejects.toThrow(/expirationTtl/);
    await expect(store.put("large", "x".repeat(100_001))).rejects.toThrow(/100 KB/);
  });
});
