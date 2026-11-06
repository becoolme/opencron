import { getDatabase } from "./database";
import type { Env } from "./types";

/**
 * API keys for the Open API and the MCP endpoint. A key is `oc_` and 32 base64url characters (24 random bytes); only
 * its SHA-256 is stored, so a key is shown once and cannot be recovered.
 */

export type ApiKeyScope = "read" | "write";
export const API_KEY_PREFIX = "oc_";
export const MAX_API_KEYS = 20;
export const MAX_KEY_NAME_LENGTH = 60;
const KEY_PATTERN = /^oc_[A-Za-z0-9_-]{32}$/;
// last_used_at is a hint, not an audit log: write it at most once a minute per key
const TOUCH_INTERVAL_S = 60;

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  created_at: number;
  last_used_at: number | null;
}

interface ApiKeyRow extends ApiKeyDto { owner_user_id: string }

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The key presented by a request: `Authorization: Bearer oc_…` or `x-api-key: oc_…`. Null when there is none. */
export function presentedApiKey(headers: Headers): string | null {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = bearer ?? headers.get("x-api-key")?.trim();
  return key && key.startsWith(API_KEY_PREFIX) ? key : null;
}

export async function listApiKeys(env: Env, owner: string): Promise<ApiKeyDto[]> {
  const { results } = await getDatabase(env).prepare(
    "SELECT id, name, prefix, scope, created_at, last_used_at FROM api_keys WHERE owner_user_id = ? ORDER BY created_at DESC, id",
  ).bind(owner).all<ApiKeyDto>();
  return results.map((row) => ({ ...row, created_at: Number(row.created_at), last_used_at: row.last_used_at == null ? null : Number(row.last_used_at) }));
}

export async function createApiKey(env: Env, owner: string, name: string, scope: ApiKeyScope): Promise<{ key: ApiKeyDto; token: string }> {
  const token = API_KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(24)));
  const key: ApiKeyDto = {
    id: crypto.randomUUID(),
    name,
    // enough to tell keys apart on the page, too little to guess the rest
    prefix: token.slice(0, 7),
    scope,
    created_at: Math.floor(Date.now() / 1000),
    last_used_at: null,
  };
  await getDatabase(env).prepare(
    "INSERT INTO api_keys (id, owner_user_id, name, prefix, key_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(key.id, owner, name, key.prefix, await hashApiKey(token), scope, key.created_at).run();
  return { key, token };
}

export interface ApiKeyUser { userId: string; name: string; email: string; scope: ApiKeyScope }

/** The account a key belongs to, or null for a malformed, unknown or revoked key. */
export async function verifyApiKey(env: Env, token: string): Promise<ApiKeyUser | null> {
  if (!KEY_PATTERN.test(token)) return null;
  const db = getDatabase(env);
  const row = await db.prepare(
    `SELECT k.id, k.owner_user_id, k.scope, k.last_used_at, u.name AS user_name, u.email AS user_email
       FROM api_keys k JOIN "user" u ON u.id = k.owner_user_id WHERE k.key_hash = ?`,
  ).bind(await hashApiKey(token)).first<Pick<ApiKeyRow, "id" | "owner_user_id" | "scope" | "last_used_at"> & { user_name: string; user_email: string }>();
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.last_used_at == null || now - Number(row.last_used_at) >= TOUCH_INTERVAL_S) {
    await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return { userId: row.owner_user_id, name: row.user_name, email: row.user_email, scope: row.scope };
}
