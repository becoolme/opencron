import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase } from "../src/database";

const connection = process.env.DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_test")) {
  throw new Error("DATABASE_URL must name a dedicated database ending in _test");
}
const db = new PostgresDatabase(connection);
const name = `adapter_test_${randomUUID().replaceAll("-", "")}`;
await db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, value TEXT)`).run();
try {
  await assert.rejects(db.batch([
    db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).bind(1, "first"),
    db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).bind(1, "duplicate"),
  ]));
  assert.deepEqual((await db.prepare(`SELECT * FROM ${name}`).all()).results, []);
  await db.batch([
    db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).bind(1, "safe ' ? $1"),
    db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).bind(2, "second"),
  ]);
  assert.deepEqual(await db.prepare(`SELECT * FROM ${name} WHERE id = ?`).bind(1).first(), {
    id: 1, value: "safe ' ? $1",
  });
  assert.equal(await db.prepare(`SELECT * FROM ${name} WHERE id = ?`).bind(3).first(), null);
  assert.deepEqual(await db.prepare("SELECT ?::bigint AS timestamp").bind(1800000000).first(), { timestamp: 1800000000 });
  console.log("PASS: PostgreSQL adapter parameters, result types, transactional batch commit and rollback");
} finally {
  await db.prepare(`DROP TABLE ${name}`).run();
}
