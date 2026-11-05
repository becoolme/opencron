#!/usr/bin/env node
/**
 * End-to-end check of the Docker deployment: builds and starts docker-compose.yml as its own throwaway project, signs
 * up, runs a JavaScript, a Python and a Go job through the sandbox, checks that scripts are locked down, then removes
 * everything it created. Needs Docker with Compose; the first run pulls the runtime images.
 *
 *   pnpm test:docker                 # build, check, tear down
 *   SMOKE_KEEP=1 pnpm test:docker    # leave the stack running to look around
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const project = `opencron-smoke-${randomBytes(3).toString("hex")}`;
const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const base = `http://localhost:${port}`;
const dir = mkdtempSync(join(tmpdir(), "opencron-smoke-"));
const envFile = join(dir, ".env");
writeFileSync(envFile, [
  `POSTGRES_PASSWORD=${randomBytes(16).toString("hex")}`,
  `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
  `SANDBOX_TOKEN=${randomBytes(32).toString("hex")}`,
  `APP_URL=${base}`,
  `OPENCRON_PORT=${port}`,
  "",
].join("\n"));

const compose = (...args) => ["compose", "-p", project, "--env-file", envFile, "-f", join(root, "docker-compose.yml"), ...args];
const docker = (args, options = {}) => execFileSync("docker", args, { cwd: root, encoding: "utf8", ...options });
const step = (text) => console.log(`\n• ${text}`);
const pass = (text) => console.log(`  ✓ ${text}`);

let failed = false;
try {
  step(`Starting ${project} on ${base}`);
  docker(compose("up", "-d", "--build", "--wait", "--wait-timeout", "600"), { stdio: "inherit" });

  step("The app serves the web build and the API");
  assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
  const page = await fetch(`${base}/zh-Hans/jobs/1`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="app"/);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  pass("deep links in any language get the app, with the security headers");
  const missing = await fetch(`${base}/api/nothing-here`);
  assert.ok([401, 404].includes(missing.status), String(missing.status));
  assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(missing.headers.get("x-frame-options"), null);
  pass("unknown API paths get a JSON error, not the app page or its headers");
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  pass("the API needs a session");

  step("Signing up");
  const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: "Docker smoke test", email: `smoke-${randomUUID()}@example.test`, password: randomUUID() }),
  });
  assert.equal(signUp.status, 200, await signUp.clone().text());
  const headers = {
    cookie: signUp.headers.getSetCookie().map((header) => header.split(";")[0]).join("; "),
    "content-type": "application/json",
    origin: base,
  };
  const api = async (path, method = "GET", body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(res.ok, `${method} ${path}: ${res.status} ${await res.clone().text()}`);
    return res.json();
  };
  assert.deepEqual((await api("/api/meta")).runtimes, ["javascript", "python", "go"]);
  pass("all three runtimes are offered");

  const runScript = async (name, runtime, script, timeout_ms = 30_000) => {
    const { job } = await api("/api/jobs", "POST", { name, type: "script", runtime, script, cron: "0 0 1 1 *", enabled: false, timeout_ms });
    return (await api(`/api/jobs/${job.id}/run`, "POST")).result;
  };

  step("Running a job in each runtime");
  const js = await runScript("smoke-js", "javascript",
    `export default { async fetch(request) { const c = await request.json(); return new Response("js:" + c.jobName); } };`);
  assert.equal(js.ok, true, JSON.stringify(js));
  assert.equal(js.response_snippet.trim(), "js:smoke-js");
  pass("JavaScript");
  const py = await runScript("smoke-py", "python",
    `import json, os\nprint("py:" + json.loads(os.environ["OPENCRON_CONTEXT"])["jobName"])\n`);
  assert.equal(py.ok, true, JSON.stringify(py));
  assert.equal(py.response_snippet.trim(), "py:smoke-py");
  pass("Python");
  const go = await runScript("smoke-go", "go", [
    "package main",
    'import ("encoding/json"; "fmt"; "os")',
    "func main() {",
    "  var c map[string]any",
    '  json.Unmarshal([]byte(os.Getenv("OPENCRON_CONTEXT")), &c)',
    '  fmt.Println("go:" + c["jobName"].(string))',
    "}",
  ].join("\n"), 60_000);
  assert.equal(go.ok, true, JSON.stringify(go));
  assert.equal(go.response_snippet.trim(), "go:smoke-go");
  pass("Go");

  step("Scripts are locked down");
  const probe = await runScript("smoke-probe", "python", [
    "import os, socket, json",
    "def attempt(f):",
    "  try: f(); return 'allowed'",
    "  except Exception: return 'blocked'",
    "print(json.dumps({",
    "  'uid': os.getuid(),",
    "  'network': attempt(lambda: socket.create_connection(('1.1.1.1', 53), 3)),",
    "  'dns': attempt(lambda: socket.getaddrinfo('example.com', 443)),",
    "  'write_root': attempt(lambda: open('/etc/opencron', 'w')),",
    "  'docker_socket': 'present' if os.path.exists('/var/run/docker.sock') else 'absent',",
    "  'secrets': sorted(k for k in os.environ if any(s in k for s in ('SECRET', 'TOKEN', 'DATABASE', 'PASSWORD'))),",
    "}))",
  ].join("\n"));
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.deepEqual(JSON.parse(probe.response_snippet), {
    uid: 65534, network: "blocked", dns: "blocked", write_root: "blocked", docker_socket: "absent", secrets: [],
  });
  pass("no network, read-only root, no Docker socket, no deployment secrets, not root");

  step("Failures are recorded");
  const boom = await runScript("smoke-fail", "python", `raise SystemExit("boom from the script")`);
  assert.equal(boom.ok, false);
  assert.match(boom.error, /boom from the script/);
  pass("a failing script reports its stderr");
  const slow = await runScript("smoke-timeout", "python", "import time\ntime.sleep(60)", 1_000);
  assert.equal(slow.ok, false);
  assert.match(slow.error, /Timed out after 1000 ms/);
  pass("a script past its timeout is stopped");

  // `docker run --rm` and `docker kill` happen asynchronously; give them a moment
  let leftovers = "";
  for (let i = 0; i < 20; i++) {
    leftovers = docker(["ps", "-a", "--filter", "name=opencron-run-", "--format", "{{.Names}}"]).trim();
    if (!leftovers) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(leftovers, "", "run containers are removed");
  pass("every run container is removed afterwards");

  console.log("\nDocker smoke test passed");
} catch (error) {
  failed = true;
  console.error("\nDocker smoke test failed:", error);
  spawnSync("docker", compose("logs", "--tail", "80"), { cwd: root, stdio: "inherit" });
} finally {
  if (process.env.SMOKE_KEEP) {
    console.log(`\nLeft running: ${base}\nRemove with: docker ${compose("down", "-v").join(" ")}`);
  } else {
    spawnSync("docker", compose("down", "-v", "--remove-orphans"), { cwd: root, stdio: "inherit" });
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
