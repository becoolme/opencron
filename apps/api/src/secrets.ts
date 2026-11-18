import { getDatabase } from "./database";
import type { Env } from "./types";

/**
 * Workspace secrets: values a script reads from its environment (env.NAME in JavaScript, os.environ in Python,
 * os.Getenv in Go) instead of keeping them in its source. Values are stored encrypted with AES-GCM under a key derived
 * from BETTER_AUTH_SECRET, bound to the account that saved them (owner_user_id) and the name, and the API never returns
 * them.
 */

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_SECRETS = 50;
export const MAX_SECRET_BYTES = 16 * 1024;
/** All of a workspace's values together; they travel to the sandbox and into each container's environment. */
export const MAX_TOTAL_SECRET_BYTES = 64 * 1024;
export const MAX_NOTE_LENGTH = 200;

/**
 * Names a secret may not take: what the runtimes and the run harness set themselves, and the storage bindings of
 * JavaScript scripts. apps/sandbox/src/secret-names.mjs keeps the same list; a test checks they agree.
 */
export const RESERVED_SECRET_NAMES = [
  "HOME", "PATH", "PWD", "USER", "SHELL", "HOSTNAME", "TMPDIR", "TZ", "LANG", "TERM",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED",
  "GOCACHE", "GOPATH", "GOROOT", "GOTMPDIR", "GOTOOLCHAIN", "GOPROXY", "GO111MODULE", "CGO_ENABLED", "GOFLAGS", "GOMAXPROCS",
  "DB", "D1", "KV",
] as const;
export const RESERVED_SECRET_PREFIXES = ["OPENCRON_", "DOCKER_", "SANDBOX_", "LD_", "SSL_", "GODEBUG", "GOENV"] as const;

/** Why a name cannot be used, or null when it can. */
export function secretNameProblem(name: string): string | null {
  if (!SECRET_NAME.test(name)) return "Use 1 to 64 capital letters, digits and underscores, not starting with a digit";
  if ((RESERVED_SECRET_NAMES as readonly string[]).includes(name)
    || RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))
    || name.endsWith("_PROXY")) {
    return `${name} is reserved for the runtime`;
  }
  return null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();

function secretKey(env: Pick<Env, "BETTER_AUTH_SECRET">): Promise<CryptoKey> {
  const master = env.BETTER_AUTH_SECRET;
  let key = keys.get(master);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(master), "HKDF", false, ["deriveKey"]).then((base) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode("opencron"), info: encoder.encode("opencron-secrets-v1") },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ));
    keys.set(master, key);
  }
  return key;
}

const additionalData = (owner: string, name: string) => encoder.encode(`${owner}\0${name}`);

export async function encryptSecret(env: Pick<Env, "BETTER_AUTH_SECRET">, owner: string, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(owner, name) },
    await secretKey(env),
    encoder.encode(value),
  );
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(sealed))}`;
}

export async function decryptSecret(env: Pick<Env, "BETTER_AUTH_SECRET">, owner: string, name: string, stored: string): Promise<string> {
  const [version, iv, sealed] = stored.split(":");
  if (version !== "v1" || !iv || !sealed) throw new Error("unknown format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: additionalData(owner, name) },
    await secretKey(env),
    fromBase64(sealed),
  );
  return decoder.decode(plain);
}

export interface SecretRow {
  id: number;
  organization_id: string;
  owner_user_id: string;
  name: string;
  value: string;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface SecretDto {
  name: string;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export async function listSecrets(env: Env, workspaceId: string): Promise<SecretDto[]> {
  const { results } = await getDatabase(env).prepare(
    "SELECT name, note, created_at, updated_at FROM secrets WHERE organization_id = ? ORDER BY name",
  ).bind(workspaceId).all<SecretDto>();
  return results.map((row) => ({ ...row, created_at: Number(row.created_at), updated_at: Number(row.updated_at) }));
}

/**
 * Decrypts every secret of a workspace for a run. Throws when one cannot be read, which happens after
 * BETTER_AUTH_SECRET changed: the run fails with a message saying which secret to save again.
 */
export async function secretsForRun(env: Env, workspaceId: string | null): Promise<Record<string, string>> {
  if (!workspaceId) return {};
  const { results } = await getDatabase(env).prepare(
    "SELECT owner_user_id, name, value FROM secrets WHERE organization_id = ? ORDER BY name",
  ).bind(workspaceId).all<Pick<SecretRow, "owner_user_id" | "name" | "value">>();
  const values: Record<string, string> = {};
  for (const row of results) {
    try {
      values[row.name] = await decryptSecret(env, row.owner_user_id, row.name, row.value);
    } catch {
      throw new Error(`Secret ${row.name} cannot be decrypted (was BETTER_AUTH_SECRET changed?). Save it again on the Secrets page.`);
    }
  }
  return values;
}

/** Hides secret values in what a run printed, longest first so one value inside another is still hidden. */
export function maskSecrets(text: string | null, secrets: Record<string, string>): string | null {
  if (!text) return text;
  const values = Object.values(secrets).filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
  let masked = text;
  for (const value of values) masked = masked.split(value).join("***");
  return masked;
}

/** A short fingerprint of the values, so a changed secret starts a fresh isolate instead of reusing the old env. */
export async function secretsFingerprint(secrets: Record<string, string>): Promise<string> {
  const names = Object.keys(secrets);
  if (names.length === 0) return "";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(names.map((name) => [name, secrets[name]]))));
  return [...new Uint8Array(digest).slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
