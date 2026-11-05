import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getDatabase, postgresSql, databaseProvider } from "../src/database";
import { ScopedScriptTables } from "../src/script-tables";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let alice: TestAccount;
let bob: TestAccount;
beforeAll(async () => {
  await applyMigrations();
  alice = await createTestAccount("tables-alice");
  bob = await createTestAccount("tables-bob");
});
beforeEach(clearDb);
async function tables(account = alice) {
  const row = await env.DB.prepare(`INSERT INTO jobs
    (name, cron, next_run_at, created_at, updated_at, owner_user_id)
    VALUES ('tables', '* * * * *', 0, 0, 0, ?) RETURNING id`).bind(account.userId).first<{ id: number }>();
  return new ScopedScriptTables(getDatabase(env), account.userId, row!.id);
}

describe("portable script tables", () => {
  it("inserts, filters, updates and deletes typed records", async () => {
    const db = await tables();
    const product = await db.insert("products", { name: "Coffee", price: 20 });
    expect(product).toMatchObject({ name: "Coffee", price: 20, available: true });
    expect(product).not.toHaveProperty("owner_user_id");
    expect(await db.select("products", { where: { available: true } })).toEqual([product]);
    expect(await db.update("products", { where: { id: product.id }, set: { price: 25, available: false } }))
      .toEqual([{ ...product, price: 25, available: false }]);
    expect(await db.select("products", { where: { available: true } })).toEqual([]);
    expect(await db.delete("products", { where: { id: product.id } })).toEqual({ deleted: 1 });
    expect(await db.select("products")).toEqual([]);
  });
  it("scopes reads and mutations to both user and job", async () => {
    const first = await tables();
    const sameUser = await tables();
    const otherUser = await tables(bob);
    const product = await first.insert("products", { name: "Private" });
    for (const other of [sameUser, otherUser]) {
      expect(await other.select("products")).toEqual([]);
      expect(await other.update("products", { where: { id: product.id }, set: { name: "Stolen" } })).toEqual([]);
      expect(await other.delete("products", { where: { id: product.id } })).toEqual({ deleted: 0 });
    }
    expect(await first.select("products")).toEqual([product]);
  });
  it("rejects system tables, injected identifiers and ownership overrides", async () => {
    const db = await tables();
    for (const name of ["user", "jobs", "__proto__", 'products"; DROP TABLE jobs; --']) {
      await expect(db.select(name)).rejects.toThrow(/Table/);
    }
    for (const field of ["owner_user_id", "job_id", "id", 'name" = NULL; --']) {
      await expect(db.insert("products", { name: "Coffee", [field]: 1 })).rejects.toThrow(/Column/);
    }
    const literal = "Coffee'); DELETE FROM jobs; --";
    expect((await db.insert("products", { name: literal })).name).toBe(literal);
  });
  it("validates types, bounds and destructive operation filters", async () => {
    const db = await tables();
    await expect(db.insert("products", {})).rejects.toThrow(/Missing/);
    await expect(db.insert("products", { name: "Coffee", price: Infinity })).rejects.toThrow(/finite/);
    await expect(db.insert("products", { name: "Coffee", available: "false" })).rejects.toThrow(/boolean/);
    await expect(db.insert("products", { name: "x".repeat(100001) })).rejects.toThrow(/100 KB/);
    for (const limit of [-1, 0, 201, 1.5, Infinity]) {
      await expect(db.select("products", { limit })).rejects.toThrow(/limit/);
    }
    await expect(db.update("products", { where: {}, set: { name: "All" } })).rejects.toThrow(/where/);
    await expect(db.delete("products", { where: {} })).rejects.toThrow(/where/);
    await expect(db.select("products", { where: { owner_user_id: alice.userId } })).rejects.toThrow(/Column/);
  });
});

describe("database selection", () => {
  it("defaults to D1 and refuses invalid or incomplete configuration", () => {
    expect(databaseProvider({})).toBe("d1");
    expect(() => databaseProvider({ DB_PROVIDER: "typo" as "d1" })).toThrow(/DB_PROVIDER/);
    expect(() => getDatabase({ ...env, DB_PROVIDER: "postgres" })).toThrow(/DATABASE_URL/);
    expect(() => getDatabase({ ...env, DB: undefined })).toThrow(/binding/);
  });
  it("converts placeholders without changing literal or commented question marks", () => {
    expect(postgresSql(`SELECT '?' AS "?", ? -- ?
, ? /* ? */`))
      .toBe(`SELECT '?' AS "?", $1 -- ?
, $2 /* ? */`);
  });
});
