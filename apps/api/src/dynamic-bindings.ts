import { WorkerEntrypoint } from "cloudflare:workers";
import { getDatabase, type Database } from "./database";
import type { Env } from "./types";

import { ScopedScriptTables, type SelectOptions, type UpdateOptions, type DeleteOptions } from "./script-tables";

interface StorageProps {
  userId: string;
  jobId: number;
}

export interface ScriptStorageEntry {
  key: string;
  value: string;
  updated_at: number;
}

export interface ScriptRecord {
  key: string;
  data: string;
  created_at: number;
  updated_at: number;
}

export interface ScriptKvEntry {
  key: string;
  expiration?: number;
}

export interface ScriptKvListResult {
  keys: ScriptKvEntry[];
  list_complete: boolean;
  cursor?: string;
}

export interface ScriptKvPutOptions {
  expirationTtl?: number;
}

function validateKey(key: string): void {
  if (
    typeof key !== "string"
    || !key
    || new TextEncoder().encode(key).byteLength > 256
  ) {
    throw new Error("storage key must contain 1..256 UTF-8 bytes");
  }
}

function validateValue(value: string): void {
  if (typeof value !== "string") throw new Error("data must be a string");
  if (new TextEncoder().encode(value).byteLength > 100_000) {
    throw new Error("data must not exceed 100 KB");
  }
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.trunc(limit), 200))
    : 100;
}

function validatePrefix(prefix: string): void {
  if (
    typeof prefix !== "string"
    || new TextEncoder().encode(prefix).byteLength > 256
  ) {
    throw new Error("prefix must be a string of at most 256 UTF-8 bytes");
  }
}

function likePrefix(prefix: string): string {
  return `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/** Testable implementation behind the RPC entrypoint. */
export class ScopedScriptStorage {
  constructor(
    private readonly db: Database,
    private readonly userId: string,
    private readonly jobId: number,
  ) {}

  async get(key: string): Promise<string | null> {
    validateKey(key);
    const row = await this.db.prepare(
      "SELECT value FROM script_storage WHERE owner_user_id = ? AND job_id = ? AND key = ?",
    ).bind(this.userId, this.jobId, key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    validateKey(key);
    validateValue(value);
    await this.db.prepare(
      `INSERT INTO script_storage (owner_user_id, job_id, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_user_id, job_id, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(this.userId, this.jobId, key, value, Math.floor(Date.now() / 1000)).run();
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.db.prepare(
      "DELETE FROM script_storage WHERE owner_user_id = ? AND job_id = ? AND key = ?",
    ).bind(this.userId, this.jobId, key).run();
  }

  async list(prefix = "", limit = 100): Promise<ScriptStorageEntry[]> {
    validatePrefix(prefix);
    const safeLimit = normalizeLimit(limit);
    const { results } = await this.db.prepare(
      `SELECT key, value, updated_at
         FROM script_storage
        WHERE owner_user_id = ? AND job_id = ? AND key LIKE ? ESCAPE '\\'
        ORDER BY key
        LIMIT ?`,
    ).bind(
      this.userId,
      this.jobId,
      likePrefix(prefix),
      safeLimit,
    ).all<ScriptStorageEntry>();
    return results;
  }
}

/** RPC-safe, per-user and per-job storage exposed to Dynamic Workers. */
export class OpenCronDatabase extends WorkerEntrypoint<Env, StorageProps> {
  #storage(): ScopedScriptStorage {
    return new ScopedScriptStorage(getDatabase(this.env), this.ctx.props.userId, this.ctx.props.jobId);
  }

  async get(key: string): Promise<string | null> {
    return this.#storage().get(key);
  }

  async put(key: string, value: string): Promise<void> {
    return this.#storage().put(key, value);
  }

  async delete(key: string): Promise<void> {
    return this.#storage().delete(key);
  }

  async list(prefix = "", limit = 100): Promise<ScriptStorageEntry[]> {
    return this.#storage().list(prefix, limit);
  }
}

/** D1-backed table visible only to one user/job sandbox. */
export class ScopedScriptRecords {
  constructor(
    private readonly db: Database,
    private readonly userId: string,
    private readonly jobId: number,
  ) {}

  async get(key: string): Promise<ScriptRecord | null> {
    validateKey(key);
    return this.db.prepare(
      `SELECT record_key AS key, data, created_at, updated_at
         FROM script_records
        WHERE owner_user_id = ? AND job_id = ? AND record_key = ?`,
    ).bind(this.userId, this.jobId, key).first<ScriptRecord>();
  }

  async put(key: string, data: string): Promise<ScriptRecord> {
    validateKey(key);
    validateValue(data);
    const now = Math.floor(Date.now() / 1000);
    const record = await this.db.prepare(
      `INSERT INTO script_records
         (owner_user_id, job_id, record_key, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_user_id, job_id, record_key)
       DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
       RETURNING record_key AS key, data, created_at, updated_at`,
    ).bind(this.userId, this.jobId, key, data, now, now).first<ScriptRecord>();
    return record!;
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.db.prepare(
      "DELETE FROM script_records WHERE owner_user_id = ? AND job_id = ? AND record_key = ?",
    ).bind(this.userId, this.jobId, key).run();
  }

  async list(prefix = "", limit = 100): Promise<ScriptRecord[]> {
    validatePrefix(prefix);
    const { results } = await this.db.prepare(
      `SELECT record_key AS key, data, created_at, updated_at
         FROM script_records
        WHERE owner_user_id = ? AND job_id = ? AND record_key LIKE ? ESCAPE '\\'
        ORDER BY record_key
        LIMIT ?`,
    ).bind(this.userId, this.jobId, likePrefix(prefix), normalizeLimit(limit)).all<ScriptRecord>();
    return results;
  }
}

/** Workers KV facade that always applies a non-forgeable user/job prefix. */
export class ScopedKvStorage {
  readonly #scopePrefix: string;

  constructor(
    private readonly kv: KVNamespace,
    userId: string,
    jobId: number,
  ) {
    this.#scopePrefix = `opencron:v1:user:${userId}:job:${jobId}:`;
  }

  async get(key: string): Promise<string | null> {
    validateKey(key);
    return this.kv.get(this.#scopePrefix + key, "text");
  }

  async put(key: string, data: string, options: ScriptKvPutOptions = {}): Promise<void> {
    validateKey(key);
    validateValue(data);
    const expirationTtl = options.expirationTtl;
    if (expirationTtl !== undefined && (
      !Number.isInteger(expirationTtl) || expirationTtl < 60 || expirationTtl > 31_536_000
    )) {
      throw new Error("expirationTtl must be an integer between 60 and 31536000 seconds");
    }
    await this.kv.put(
      this.#scopePrefix + key,
      data,
      expirationTtl === undefined ? undefined : { expirationTtl },
    );
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.kv.delete(this.#scopePrefix + key);
  }

  async list(prefix = "", limit = 100, cursor?: string): Promise<ScriptKvListResult> {
    validatePrefix(prefix);
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 4096)) {
      throw new Error("cursor is invalid");
    }
    const result = await this.kv.list({
      prefix: this.#scopePrefix + prefix,
      limit: normalizeLimit(limit),
      ...(cursor ? { cursor } : {}),
    });
    return {
      keys: result.keys.map((entry) => ({
        key: entry.name.slice(this.#scopePrefix.length),
        ...(entry.expiration === undefined ? {} : { expiration: entry.expiration }),
      })),
      list_complete: result.list_complete,
      ...("cursor" in result ? { cursor: result.cursor } : {}),
    };
  }
}

/** Structured D1 capability; no raw SQL, identifiers, DDL, or native binding. */
export class OpenCronD1 extends WorkerEntrypoint<Env, StorageProps> {
  #records(): ScopedScriptRecords {
    return new ScopedScriptRecords(getDatabase(this.env), this.ctx.props.userId, this.ctx.props.jobId);
  }

  async get(key: string): Promise<ScriptRecord | null> {
    return this.#records().get(key);
  }

  async put(key: string, data: string): Promise<ScriptRecord> {
    return this.#records().put(key, data);
  }

  async delete(key: string): Promise<void> {
    return this.#records().delete(key);
  }

  async list(prefix = "", limit = 100): Promise<ScriptRecord[]> {
    return this.#records().list(prefix, limit);
  }
}

/** Prefix-scoped KV capability; the native namespace never enters the sandbox. */
export class OpenCronKV extends WorkerEntrypoint<Env, StorageProps> {
  #storage(): ScopedKvStorage {
    return new ScopedKvStorage(this.env.SCRIPT_KV, this.ctx.props.userId, this.ctx.props.jobId);
  }

  async get(key: string): Promise<string | null> {
    return this.#storage().get(key);
  }

  async put(key: string, data: string, options?: ScriptKvPutOptions): Promise<void> {
    return this.#storage().put(key, data, options);
  }

  async delete(key: string): Promise<void> {
    return this.#storage().delete(key);
  }

  async list(prefix = "", limit = 100, cursor?: string): Promise<ScriptKvListResult> {
    return this.#storage().list(prefix, limit, cursor);
  }
}

/** Portable table operations backed by the deployment's selected database. */
export class OpenCronTables extends WorkerEntrypoint<Env, StorageProps> {
  #tables(): ScopedScriptTables {
    return new ScopedScriptTables(getDatabase(this.env), this.ctx.props.userId, this.ctx.props.jobId);
  }
  async insert(table: string, data: Parameters<ScopedScriptTables["insert"]>[1]) {
    return this.#tables().insert(table, data);
  }
  async select(table: string, options?: SelectOptions) { return this.#tables().select(table, options); }
  async update(table: string, options: UpdateOptions) { return this.#tables().update(table, options); }
  async delete(table: string, options: DeleteOptions) { return this.#tables().delete(table, options); }
}
