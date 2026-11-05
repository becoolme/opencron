import type { Database } from "./database";

type Scalar = string | number | boolean | null;
type Row = Record<string, Scalar>;
type Column = { type: "string" | "number" | "boolean"; required?: boolean; writable?: boolean };
type Table = { physicalName: string; columns: Record<string, Column> };

/** Deployment-owned allowlist. Add matching D1 and PostgreSQL migrations for new tables. */
export const scriptTables: Record<string, Table> = {
  products: {
    physicalName: "script_products",
    columns: {
      id: { type: "number", writable: false },
      name: { type: "string", required: true },
      price: { type: "number" },
      available: { type: "boolean" },
    },
  },
};

export type SelectOptions = { where?: Row; limit?: number };
export type UpdateOptions = { where: Row; set: Row };
export type DeleteOptions = { where: Row };

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
}

function tableDefinition(name: string): Table {
  if (typeof name !== "string" || !Object.hasOwn(scriptTables, name)) throw new Error("Table is not allowed");
  return scriptTables[name];
}

function encode(column: Column, value: unknown): Scalar {
  if (value === null || typeof value !== column.type) throw new Error(`Expected ${column.type}`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Expected a finite number");
  if (typeof value === "string" && new TextEncoder().encode(value).byteLength > 100_000) {
    throw new Error("Value must not exceed 100 KB");
  }
  return typeof value === "boolean" ? Number(value) : value as Scalar;
}

function fields(table: Table, row: unknown, writable: boolean): [string, Scalar][] {
  object(row);
  return Object.entries(row).map(([key, value]) => {
    if (!Object.hasOwn(table.columns, key) || (writable && table.columns[key].writable === false)) {
      throw new Error(`Column is not allowed: ${key}`);
    }
    return [key, encode(table.columns[key], value)];
  });
}

function decode(table: Table, row: Row): Row {
  return Object.fromEntries(Object.entries(table.columns).map(([key, column]) => [
    key, column.type === "boolean" ? row[key] === 1 : row[key],
  ]));
}

/** Structured CRUD; ownership is always supplied by the host, never the script. */
export class ScopedScriptTables {
  constructor(private readonly db: Database, private readonly userId: string, private readonly jobId: number) {}

  #scope(table: Table, where: unknown, requireFilter = false): { sql: string; values: Scalar[] } {
    const filters = fields(table, where, false);
    if (requireFilter && !filters.length) throw new Error("A non-empty where filter is required");
    return {
      sql: `owner_user_id = ? AND job_id = ?${filters.map(([key]) => ` AND "${key}" = ?`).join("")}`,
      values: [this.userId, this.jobId, ...filters.map(([, value]) => value)],
    };
  }

  async insert(name: string, data: Row): Promise<Row> {
    const table = tableDefinition(name);
    const entries = fields(table, data, true);
    for (const [key, column] of Object.entries(table.columns)) {
      if (column.required && !entries.some(([field]) => field === key)) throw new Error(`Missing column: ${key}`);
    }
    const keys = ["owner_user_id", "job_id", ...entries.map(([key]) => key)];
    const row = await this.db.prepare(
      `INSERT INTO "${table.physicalName}" (${keys.map((key) => `"${key}"`).join(", ")})
       VALUES (${keys.map(() => "?").join(", ")}) RETURNING *`,
    ).bind(this.userId, this.jobId, ...entries.map(([, value]) => value)).first<Row>();
    return decode(table, row!);
  }

  async select(name: string, options: SelectOptions = {}): Promise<Row[]> {
    const table = tableDefinition(name);
    object(options);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1..200");
    const scope = this.#scope(table, options.where ?? {});
    const { results } = await this.db.prepare(
      `SELECT * FROM "${table.physicalName}" WHERE ${scope.sql} ORDER BY id LIMIT ?`,
    ).bind(...scope.values, limit).all<Row>();
    return results.map((row) => decode(table, row));
  }

  async update(name: string, options: UpdateOptions): Promise<Row[]> {
    const table = tableDefinition(name);
    object(options);
    const scope = this.#scope(table, options.where, true);
    const entries = fields(table, options.set, true);
    if (!entries.length) throw new Error("A non-empty set is required");
    const { results } = await this.db.prepare(
      `UPDATE "${table.physicalName}" SET ${entries.map(([key]) => `"${key}" = ?`).join(", ")}
       WHERE ${scope.sql} RETURNING *`,
    ).bind(...entries.map(([, value]) => value), ...scope.values).all<Row>();
    return results.map((row) => decode(table, row));
  }

  async delete(name: string, options: DeleteOptions): Promise<{ deleted: number }> {
    const table = tableDefinition(name);
    object(options);
    const scope = this.#scope(table, options.where, true);
    const { results } = await this.db.prepare(
      `DELETE FROM "${table.physicalName}" WHERE ${scope.sql} RETURNING id`,
    ).bind(...scope.values).all();
    return { deleted: results.length };
  }
}
