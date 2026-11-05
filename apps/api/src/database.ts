import { Client, Pool, types } from "pg";
import type { Env } from "./types";

/** Portable subset of D1's prepared API used by application repositories. */
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}

export function databaseProvider(env: Pick<Env, "DB_PROVIDER">): "d1" | "postgres" {
  const provider = env.DB_PROVIDER ?? "d1";
  if (provider !== "d1" && provider !== "postgres") throw new Error("Invalid DB_PROVIDER");
  return provider;
}

export function postgresConnection(env: Env): string {
  const connection = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connection) throw new Error("PostgreSQL requires DATABASE_URL or HYPERDRIVE");
  return connection;
}

export function authPool(env: Env): Pool {
  // Never share live connections between Worker requests. Hyperdrive pools upstream.
  return new Pool({ connectionString: postgresConnection(env), max: 2, connectionTimeoutMillis: 10_000 });
}

/** Only internal SQL reaches this function; user values remain bound parameters. */
export function postgresSql(sql: string): string {
  let parameter = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?/g,
    (token) => token === "?" ? `$${++parameter}` : token);
}

class PostgresStatement implements Statement {
  constructor(readonly database: PostgresDatabase, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]): PostgresStatement { return new PostgresStatement(this.database, this.sql, values); }
  async first<T>(): Promise<T | null> { return (await this.all<T>()).results[0] ?? null; }
  async all<T>(): Promise<{ results: T[] }> {
    return this.database.withClient(async (client) => ({
      results: (await client.query(postgresSql(this.sql), this.values)).rows as T[],
    }));
  }
  async run(): Promise<unknown> { return this.all(); }
}

const pgTypes = {
  getTypeParser(oid: number, format?: string) {
    return oid === 20 && format !== "binary" ? (value: string) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("PostgreSQL integer exceeds the safe integer range");
      return number;
    } : types.getTypeParser(oid, format as "text");
  },
};

export class PostgresDatabase implements Database {
  constructor(private readonly connectionString: string) {}
  prepare(sql: string): PostgresStatement { return new PostgresStatement(this, sql); }
  async withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 10_000, types: pgTypes });
    try {
      await client.connect();
      return await operation(client);
    } finally {
      await client.end();
    }
  }
  async batch(statements: Statement[]): Promise<unknown> {
    const queries = statements.map((statement) => {
      if (!(statement instanceof PostgresStatement) || statement.database !== this) {
        throw new Error("Batch statements must belong to the same database");
      }
      return statement;
    });
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        for (const statement of queries) await client.query(postgresSql(statement.sql), statement.values);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
}

export function getDatabase(env: Env): Database {
  if (databaseProvider(env) === "postgres") return new PostgresDatabase(postgresConnection(env));
  if (!env.DB) throw new Error("D1 requires the DB binding");
  const db = env.DB;
  return {
    prepare: (sql) => db.prepare(sql),
    batch: (statements) => db.batch(statements as D1PreparedStatement[]),
  };
}
