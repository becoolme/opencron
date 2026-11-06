/**
 * The sandbox HTTP service, run as a real process with a fake `docker` on its PATH (test/fixtures/fake-docker.mjs), so
 * authentication, limits, timeouts and queueing are checked without a Docker daemon.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const SERVER = new URL("../src/server.mjs", import.meta.url).pathname;
const FAKE_DOCKER = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const TOKEN = "test-sandbox-token-0123456789";
// plain tags keep the assertions readable; the pinned defaults are checked in docker-policy.test.mjs
const IMAGES = { SANDBOX_IMAGE_NODE: "node:22-alpine", SANDBOX_IMAGE_PYTHON: "python:3.12-alpine", SANDBOX_IMAGE_GO: "golang:1.23-alpine" };

const dir = mkdtempSync(join(tmpdir(), "opencron-sandbox-test-"));
writeFileSync(join(dir, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER}" "$@"\n`);
chmodSync(join(dir, "docker"), 0o755);
after(() => rmSync(dir, { recursive: true, force: true }));

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Starts the sandbox; resolves once it listens, or with its exit code if it refuses to start. */
async function start(env = {}) {
  const port = await freePort();
  const log = join(dir, `docker-${port}.log`);
  writeFileSync(log, "");
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: `${dir}:${process.env.PATH}`, SANDBOX_TOKEN: TOKEN, PORT: String(port), FAKE_DOCKER_LOG: log, ...IMAGES, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => {
    child.stdout.on("data", () => { if (output.includes("listening")) resolve(null); });
    child.on("exit", (code) => resolve(code));
  });
  return {
    exitCode,
    output: () => output,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    url: (path) => `http://127.0.0.1:${port}${path}`,
    stop: () => new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.on("exit", resolve); child.kill("SIGTERM"); } }),
  };
}

const run = (sandbox, body, headers = {}) => fetch(sandbox.url("/run"), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("refusing to start", () => {
  for (const [label, token] of [["no token", ""], ["the example token", "change-me-sandbox-token"], ["a short token", "0123456789"]]) {
    test(`with ${label}`, async () => {
      const sandbox = await start({ SANDBOX_TOKEN: token });
      assert.equal(sandbox.exitCode, 1);
      assert.match(sandbox.output(), /SANDBOX_TOKEN must be set/);
    });
  }
});

describe("a running sandbox", () => {
  let sandbox;
  before(async () => { sandbox = await start({ FAKE_DOCKER_MISSING: "python:3.12-alpine" }); });
  after(() => sandbox.stop());

  test("pulls missing images at startup, and only those", () => {
    const calls = sandbox.calls();
    assert.deepEqual(calls.filter((c) => c.cmd === "inspect").map((c) => c.image).sort(),
      ["golang:1.23-alpine", "node:22-alpine", "python:3.12-alpine"]);
    assert.deepEqual(calls.filter((c) => c.cmd === "pull").map((c) => c.target), ["python:3.12-alpine"]);
  });

  test("reports health without a token", async () => {
    const res = await fetch(sandbox.url("/healthz"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, runtimes: ["javascript", "python", "go"] });
  });

  test("needs the token to run anything", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const res = await run(sandbox, { runtime: "python", source: "echo" }, { authorization });
      assert.equal(res.status, 401, String(authorization));
    }
    assert.equal(sandbox.calls().filter((c) => c.cmd === "run").length, 0);
  });

  test("answers only POST /run", async () => {
    assert.equal((await fetch(sandbox.url("/run"))).status, 404);
    assert.equal((await fetch(sandbox.url("/other"), { method: "POST" })).status, 404);
  });

  test("rejects bad requests before starting a container", async () => {
    const before = sandbox.calls().filter((c) => c.cmd === "run").length;
    assert.equal((await run(sandbox, "{", {})).status, 400);
    assert.equal((await run(sandbox, "x", { "content-type": "text/plain" })).status, 415);
    assert.equal((await run(sandbox, { runtime: "bash", source: "echo" })).status, 400);
    assert.equal((await run(sandbox, { runtime: "python", source: "" })).status, 400);
    assert.equal((await run(sandbox, { runtime: "python", source: "x".repeat(512 * 1024 + 1) })).status, 400);
    assert.equal(sandbox.calls().filter((c) => c.cmd === "run").length, before);
  });

  test("refuses an oversized body", async () => {
    const res = await run(sandbox, { runtime: "python", source: "echo", pad: "x".repeat(700 * 1024) }).catch((error) => error);
    // the server answers 413 and drops the connection; either is a refusal
    if (res instanceof Response) assert.equal(res.status, 413);
    else assert.ok(res instanceof Error);
  });

  test("runs the script in a locked-down container", async () => {
    const res = await run(sandbox, { runtime: "python", source: "echo", context: { job: { id: 7 } }, timeout_ms: 5000 });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    const { args, source } = JSON.parse(result.stdout);
    assert.equal(source, "echo");
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("python:3.12-alpine"));
    assert.ok(args.includes(`OPENCRON_CONTEXT=${JSON.stringify({ job: { id: 7 } })}`));
    assert.match(args[args.indexOf("--name") + 1], /^opencron-run-[0-9a-f]{16}$/);
  });

  test("returns the exit code and stderr of a failed script", async () => {
    const result = await (await run(sandbox, { runtime: "javascript", source: "fail" })).json();
    assert.equal(result.exit_code, 3);
    assert.equal(result.stderr, "boom");
  });

  test("caps stdout and stderr at 64 KB each", async () => {
    const result = await (await run(sandbox, { runtime: "go", source: "flood" })).json();
    assert.equal(result.stdout.length, 64 * 1024);
    assert.equal(result.stderr.length, 64 * 1024);
  });

  test("kills a script that runs past its timeout", async () => {
    const started = Date.now();
    // the minimum timeout is 1 s, plus 2 s of startup grace for Python
    const result = await (await run(sandbox, { runtime: "python", source: "hang", timeout_ms: 1 })).json();
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.ok(elapsed >= 2_900 && elapsed < 6_000, `took ${elapsed} ms`);
    const { args } = sandbox.calls().filter((c) => c.cmd === "run").at(-1);
    const name = args[args.indexOf("--name") + 1];
    // `docker kill` is fired alongside killing the client, so it may land just after the response
    const killed = () => sandbox.calls().some((c) => c.cmd === "kill" && c.target === name);
    for (let i = 0; i < 40 && !killed(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(killed(), "the container is killed by name");
  });
});

describe("under load", () => {
  test("runs one script at a time at concurrency 1 and refuses beyond the queue", async () => {
    const sandbox = await start({ SANDBOX_CONCURRENCY: "1" });
    try {
      // one running and a queue of 8 (concurrency × 8); the tenth is refused
      const responses = await Promise.all(Array.from({ length: 10 }, () => run(sandbox, { runtime: "javascript", source: "slow:150" })));
      const statuses = responses.map((res) => res.status).sort();
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);
      // each run starts only after the previous one finished
      const events = sandbox.calls().filter((c) => c.cmd === "run" || c.cmd === "done").map((c) => c.cmd);
      assert.deepEqual(events, Array.from({ length: 9 }, () => ["run", "done"]).flat());
    } finally {
      await sandbox.stop();
    }
  });

  test("keeps one account to its share of the slots", async () => {
    const sandbox = await start({ SANDBOX_CONCURRENCY: "2" });
    try {
      const slow = (owner, ms) => run(sandbox, { runtime: "javascript", source: `slow:${ms}`, owner });
      const busy = [slow("busy", 800), slow("busy", 800), slow("busy", 800)];
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      const other = await slow("other", 50);
      assert.equal(other.status, 200);
      // the other account took the second slot instead of waiting ~700 ms behind the busy one
      assert.ok(Date.now() - started < 500, `waited ${Date.now() - started} ms`);
      assert.deepEqual((await Promise.all(busy)).map((res) => res.status), [200, 200, 200]);
    } finally {
      await sandbox.stop();
    }
  });
});
