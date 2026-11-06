/**
 * Which environment variables a run may receive from the app as secrets. The same rules as RESERVED_SECRET_NAMES in
 * apps/api/src/secrets.ts (a test checks they agree): the sandbox enforces them again so that whoever holds
 * SANDBOX_TOKEN still cannot override what the harness and the runtimes set.
 */

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_SECRETS = 50;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_TOTAL_SECRET_BYTES = 64 * 1024;

export const RESERVED_SECRET_NAMES = [
  "HOME", "PATH", "PWD", "USER", "SHELL", "HOSTNAME", "TMPDIR", "TZ", "LANG", "TERM",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED",
  "GOCACHE", "GOPATH", "GOROOT", "GOTMPDIR", "GOTOOLCHAIN", "GOPROXY", "GO111MODULE", "CGO_ENABLED", "GOFLAGS", "GOMAXPROCS",
  "DB", "D1", "KV",
];
export const RESERVED_SECRET_PREFIXES = ["OPENCRON_", "DOCKER_", "SANDBOX_", "LD_", "SSL_", "GODEBUG", "GOENV"];

export function allowedSecretName(name) {
  return SECRET_NAME.test(name)
    && !RESERVED_SECRET_NAMES.includes(name)
    && !RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))
    && !name.endsWith("_PROXY");
}

/** Checks the `env` of a run request; returns the variables or throws with status 400. */
export function readSecrets(value) {
  if (value === undefined || value === null) return {};
  const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (typeof value !== "object" || Array.isArray(value)) refuse("env must be an object of strings");
  const entries = Object.entries(value);
  if (entries.length > MAX_SECRETS) refuse(`env can hold at most ${MAX_SECRETS} variables`);
  let total = 0;
  for (const [name, secret] of entries) {
    if (!allowedSecretName(name)) refuse(`env variable ${name} is not allowed`);
    if (typeof secret !== "string" || secret.includes("\0")) refuse(`env variable ${name} must be a string`);
    const bytes = Buffer.byteLength(secret);
    if (bytes > MAX_SECRET_BYTES) refuse(`env variable ${name} is too long`);
    total += bytes;
  }
  if (total > MAX_TOTAL_SECRET_BYTES) refuse("env is too large");
  return Object.fromEntries(entries);
}
