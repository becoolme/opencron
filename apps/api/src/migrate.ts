import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * Applies the PostgreSQL migrations in order, once each. Node only (the CLI script and the Docker server). The folder is
 * found next to this file's directory, which holds for `src/` and for the bundled `dist/`.
 */
export async function migratePostgres(connectionString: string, log: (line: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(781052431)");
    await client.query(`CREATE TABLE IF NOT EXISTS _opencron_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const directory = fileURLToPath(new URL("../migrations/postgres/", import.meta.url).href);
    for (const name of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query("SELECT checksum FROM _opencron_migrations WHERE name = $1", [name]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO _opencron_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
      log(`Applied ${name}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
