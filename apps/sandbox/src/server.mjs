import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { DEFAULT_IMAGES, RUNTIMES, dockerArgs } from "./docker-args.mjs";
import { RunQueue } from "./run-queue.mjs";
import { readSecrets } from "./secret-names.mjs";

/**
 * The OpenCron sandbox: runs one Node, Python or Go script per request, each in a fresh locked-down container.
 * It reaches Docker through the guard (docker-guard.mjs), not the socket, and is reachable only on the internal compose
 * network.
 */

const TOKEN = process.env.SANDBOX_TOKEN ?? "";
if (TOKEN.length < 16 || /^change-me/i.test(TOKEN)) {
  console.error("SANDBOX_TOKEN must be set to a random value of at least 16 characters (openssl rand -hex 32)");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 8787);
const CONCURRENCY = Math.max(1, Number(process.env.SANDBOX_CONCURRENCY ?? 4));
// one account may hold this many of the slots, so it cannot keep everyone else's scripts waiting
const OWNER_CONCURRENCY = Math.max(1, Number(process.env.SANDBOX_OWNER_CONCURRENCY) || Math.floor(CONCURRENCY / 2));
const NETWORK = process.env.SANDBOX_NETWORK || "none";
const DOCKER_RUNTIME = process.env.SANDBOX_DOCKER_RUNTIME || undefined;
const IMAGES = {
  javascript: process.env.SANDBOX_IMAGE_NODE || DEFAULT_IMAGES.javascript,
  python: process.env.SANDBOX_IMAGE_PYTHON || DEFAULT_IMAGES.python,
  go: process.env.SANDBOX_IMAGE_GO || DEFAULT_IMAGES.go,
};
const MAX_SOURCE = 512 * 1024;
// the source, the context and up to 64 KB of secrets
const MAX_BODY = MAX_SOURCE + 192 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_TIMEOUT = 300_000;
// Go compiles before it runs; give it room on top of the job's own timeout.
const STARTUP_GRACE = { javascript: 2_000, python: 2_000, go: 30_000 };

if (NETWORK !== "none") {
  console.warn(`SANDBOX_NETWORK=${NETWORK}: scripts can reach that network. Keep it away from internal services.`);
}

const queue = new RunQueue({ concurrency: CONCURRENCY, perOwner: OWNER_CONCURRENCY });

// What the docker CLI runs with: this process's environment without the sandbox's own settings, so the token stays here.
const CLI_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SANDBOX_")));

/** `secrets` are added to the CLI's environment, where `--env NAME` in the args picks them up. */
function docker(args, { stdin, timeoutMs, name, secrets } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...CLI_ENV, ...secrets } });
    const out = { stdout: "", stderr: "" };
    const collect = (key) => (chunk) => {
      if (out[key].length < MAX_OUTPUT) out[key] += chunk.toString("utf8").slice(0, MAX_OUTPUT - out[key].length);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      if (name) spawn("docker", ["kill", name], { stdio: "ignore" });
      child.kill("SIGKILL");
    }, timeoutMs) : null;
    child.on("error", (error) => { out.stderr += String(error.message); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exit_code: code ?? -1, stdout: out.stdout, stderr: out.stderr, timed_out: timedOut, duration_ms: Date.now() - started });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

function authorized(header) {
  const given = Buffer.from(String(header ?? "").replace(/^Bearer /, ""));
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function run(input) {
  const { runtime, source } = input ?? {};
  if (!RUNTIMES.includes(runtime)) throw Object.assign(new Error("Unknown runtime"), { status: 400 });
  if (typeof source !== "string" || !source || Buffer.byteLength(source) > MAX_SOURCE) {
    throw Object.assign(new Error("source must be a non-empty string of at most 512 KB"), { status: 400 });
  }
  const timeout = Math.min(Math.max(Number(input.timeout_ms) || 30_000, 1_000), MAX_TIMEOUT);
  const context = JSON.stringify(input.context ?? {});
  const owner = typeof input.owner === "string" ? input.owner.slice(0, 200) : "";
  const secrets = readSecrets(input.env);
  const name = `opencron-run-${randomBytes(8).toString("hex")}`;
  const args = dockerArgs({
    runtime, name, context, image: IMAGES[runtime], network: NETWORK, dockerRuntime: DOCKER_RUNTIME, secretNames: Object.keys(secrets),
  });
  await queue.acquire(owner);
  try {
    const result = await docker(args, { stdin: source, timeoutMs: timeout + STARTUP_GRACE[runtime], name, secrets });
    // Docker reports its own failures (missing image, daemon down) as 125
    if (result.exit_code === 125 && !result.timed_out) console.error(`docker run failed: ${result.stderr.slice(0, 500)}`);
    return result;
  } finally {
    queue.release(owner);
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true, runtimes: RUNTIMES });
    if (req.method !== "POST" || req.url !== "/run") return send(res, 404, { error: "not found" });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "expected JSON" });
    let input;
    try { input = JSON.parse(await readBody(req)); } catch (error) {
      if (error.status) throw error;
      return send(res, 400, { error: "invalid JSON" });
    }
    send(res, 200, await run(input));
  } catch (error) {
    send(res, error.status ?? 500, { error: error.status ? error.message : "sandbox error" });
    if (!error.status) console.error(error);
  }
});
server.requestTimeout = MAX_TIMEOUT + 60_000;

// Pull the images up front: runs use --pull never, so a script can never trigger a pull of something else.
for (const image of new Set(Object.values(IMAGES))) {
  const inspected = await docker(["image", "inspect", image]);
  if (inspected.exit_code === 0) continue;
  console.log(`Pulling ${image}`);
  const pulled = await docker(["pull", image], { timeoutMs: 600_000 });
  if (pulled.exit_code !== 0) console.error(`Could not pull ${image}: ${pulled.stderr.slice(0, 300)}`);
}

server.listen(PORT, () => console.log(`OpenCron sandbox listening on :${PORT} (concurrency ${CONCURRENCY}, ${OWNER_CONCURRENCY} per account)`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
