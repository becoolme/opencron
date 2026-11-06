import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MAX_SECRETS, MAX_SECRET_BYTES, MAX_TOTAL_SECRET_BYTES, RESERVED_SECRET_NAMES, RESERVED_SECRET_PREFIXES, allowedSecretName, readSecrets,
} from "../src/secret-names.mjs";

const api = readFileSync(new URL("../../api/src/secrets.ts", import.meta.url), "utf8");
const list = (name) => JSON.parse(`[${api.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))[1].replace(/,\s*$/, "")}]`);
const number = (name) => Function(`return ${api.match(new RegExp(`export const ${name} = ([^;]+);`))[1]}`)();

test("the sandbox reserves the same names as the app", () => {
  assert.deepEqual(RESERVED_SECRET_NAMES, list("RESERVED_SECRET_NAMES"));
  assert.deepEqual(RESERVED_SECRET_PREFIXES, list("RESERVED_SECRET_PREFIXES"));
  assert.equal(MAX_SECRETS, number("MAX_SECRETS"));
  assert.equal(MAX_SECRET_BYTES, number("MAX_SECRET_BYTES"));
  assert.equal(MAX_TOTAL_SECRET_BYTES, number("MAX_TOTAL_SECRET_BYTES"));
});

test("names the runtime sets itself are refused", () => {
  for (const name of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "OPENCRON_CONTEXT", "DOCKER_HOST", "SANDBOX_TOKEN", "HTTPS_PROXY", "GOFLAGS", "KV"]) {
    assert.equal(allowedSecretName(name), false, name);
  }
  for (const name of ["API_TOKEN", "WEBHOOK_URL", "_PRIVATE", "TOKEN2"]) assert.equal(allowedSecretName(name), true, name);
  for (const name of ["api_token", "2FA", "A-B", "", "A".repeat(65)]) assert.equal(allowedSecretName(name), false, name);
});

test("a run's env is checked", () => {
  assert.deepEqual(readSecrets(undefined), {});
  assert.deepEqual(readSecrets({ API_TOKEN: "x" }), { API_TOKEN: "x" });
  assert.throws(() => readSecrets(["x"]), { status: 400 });
  assert.throws(() => readSecrets({ PATH: "/evil" }), /PATH is not allowed/);
  assert.throws(() => readSecrets({ A: 1 }), { status: 400 });
  assert.throws(() => readSecrets({ A: "a\0b" }), { status: 400 });
  assert.throws(() => readSecrets({ A: "x".repeat(MAX_SECRET_BYTES + 1) }), /too long/);
  const many = Object.fromEntries(Array.from({ length: MAX_SECRETS + 1 }, (_, i) => [`S${i}`, "x"]));
  assert.throws(() => readSecrets(many), /at most/);
  const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`S${i}`, "x".repeat(MAX_SECRET_BYTES)]));
  assert.throws(() => readSecrets(big), /too large/);
});
