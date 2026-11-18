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
  /** Projects the key is limited to; null means every project of the workspace. */
  project_ids: string[] | null;
  /** The account that created the key; the key acts as that account. */
  created_by: { id: string; name: string } | null;
  created_at: number;
  last_used_at: number | null;
}

interface ApiKeyRow { id: string; owner_user_id: string; scope: ApiKeyScope; last_used_at: number | null; project_ids: string | null; organization_id: string | null }

export function parseProjectIds(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) && ids.length > 0 ? ids.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

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

type ListedKeyRow = Omit<ApiKeyDto, "project_ids" | "created_by"> & { project_ids: string | null; owner_user_id: string; owner_name: string | null };

export async function listApiKeys(env: Env, workspaceId: string): Promise<ApiKeyDto[]> {
  const { results } = await getDatabase(env).prepare(
    `SELECT k.id, k.name, k.prefix, k.scope, k.project_ids, k.created_at, k.last_used_at, k.owner_user_id, u.name AS owner_name
       FROM api_keys k LEFT JOIN "user" u ON u.id = k.owner_user_id
      WHERE k.organization_id = ? ORDER BY k.created_at DESC, k.id`,
  ).bind(workspaceId).all<ListedKeyRow>();
  return results.map(({ owner_user_id, owner_name, ...row }) => ({
    ...row,
    project_ids: parseProjectIds(row.project_ids),
    created_by: { id: owner_user_id, name: owner_name ?? "" },
    created_at: Number(row.created_at),
    last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
  }));
}

export async function createApiKey(
  env: Env,
  owner: { id: string; name: string },
  workspaceId: string,
  name: string,
  scope: ApiKeyScope,
  projectIds: string[] | null,
): Promise<{ key: ApiKeyDto; token: string }> {
  const token = API_KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(24)));
  const key: ApiKeyDto = {
    id: crypto.randomUUID(),
    name,
    // enough to tell keys apart on the page, too little to guess the rest
    prefix: token.slice(0, 7),
    scope,
    project_ids: projectIds && projectIds.length > 0 ? projectIds : null,
    created_by: { id: owner.id, name: owner.name },
    created_at: Math.floor(Date.now() / 1000),
    last_used_at: null,
  };
  await getDatabase(env).prepare(
    `INSERT INTO api_keys (id, owner_user_id, organization_id, name, prefix, key_hash, scope, project_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(key.id, owner.id, workspaceId, name, key.prefix, await hashApiKey(token), scope,
    key.project_ids ? JSON.stringify(key.project_ids) : null, key.created_at).run();
  return { key, token };
}

export interface ApiKeyUser {
  userId: string;
  name: string;
  email: string;
  scope: ApiKeyScope;
  workspaceId: string | null;
  projectIds: string[] | null;
}

/** The account a key belongs to, or null for a malformed, unknown or revoked key. */
export async function verifyApiKey(env: Env, token: string): Promise<ApiKeyUser | null> {
  if (!KEY_PATTERN.test(token)) return null;
  const db = getDatabase(env);
  const row = await db.prepare(
    `SELECT k.id, k.owner_user_id, k.organization_id, k.project_ids, k.scope, k.last_used_at, u.name AS user_name, u.email AS user_email
       FROM api_keys k JOIN "user" u ON u.id = k.owner_user_id WHERE k.key_hash = ?`,
  ).bind(await hashApiKey(token)).first<ApiKeyRow & { user_name: string; user_email: string }>();
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.last_used_at == null || now - Number(row.last_used_at) >= TOUCH_INTERVAL_S) {
    await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return {
    userId: row.owner_user_id,
    name: row.user_name,
    email: row.user_email,
    scope: row.scope,
    workspaceId: row.organization_id,
    projectIds: parseProjectIds(row.project_ids),
  };
}
