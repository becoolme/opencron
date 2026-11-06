import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNTIMES, dockerArgs } from "../src/docker-args.mjs";

const flag = (args, name) => args[args.indexOf(name) + 1];

for (const runtime of RUNTIMES) {
  test(`${runtime} runs are locked down`, () => {
    const args = dockerArgs({ runtime, name: "opencron-run-x", context: "{}" });
    assert.equal(flag(args, "--network"), "none");
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--rm"));
    assert.equal(flag(args, "--cap-drop"), "ALL");
    assert.equal(flag(args, "--security-opt"), "no-new-privileges");
    assert.equal(flag(args, "--user"), "65534:65534");
    assert.equal(flag(args, "--pids-limit"), "64");
    assert.equal(flag(args, "--memory"), flag(args, "--memory-swap"));
    assert.equal(flag(args, "--pull"), "never");
    assert.equal(flag(args, "--ipc"), "none");
    assert.match(flag(args, "--tmpfs"), /^\/tmp:.*nosuid.*size=/);
    assert.ok(!args.includes("--privileged"));
    assert.ok(!args.some((arg) => arg.startsWith("-v") || arg === "--volume" || arg === "--mount"));
  });
}

test("only Go may execute from /tmp", () => {
  assert.match(flag(dockerArgs({ runtime: "javascript", name: "a", context: "{}" }), "--tmpfs"), /noexec/);
  assert.match(flag(dockerArgs({ runtime: "python", name: "a", context: "{}" }), "--tmpfs"), /noexec/);
  assert.doesNotMatch(flag(dockerArgs({ runtime: "go", name: "a", context: "{}" }), "--tmpfs"), /noexec/);
});

test("Go cannot download modules or toolchains", () => {
  const args = dockerArgs({ runtime: "go", name: "a", context: "{}" });
  assert.ok(args.includes("GOPROXY=off"));
  assert.ok(args.includes("GOTOOLCHAIN=local"));
});

test("Go builds within the process limit", () => {
  // without these the compiler starts one worker per host CPU and hits --pids-limit on a large machine
  const args = dockerArgs({ runtime: "go", name: "a", context: "{}" });
  assert.ok(args.includes("GOFLAGS=-p=1"));
  assert.ok(args.includes("GOMAXPROCS=1"));
  assert.equal(flag(args, "--cpus"), "1");
});

test("the context travels as an env value, not through a shell", () => {
  const context = JSON.stringify({ job: "$(rm -rf /)" });
  const args = dockerArgs({ runtime: "python", name: "a", context });
  assert.ok(args.includes(`OPENCRON_CONTEXT=${context}`));
  assert.ok(!flag(args, "-c").includes("rm -rf"));
});

test("operator options are applied", () => {
  const args = dockerArgs({ runtime: "python", name: "a", context: "{}", image: "python:3.13-alpine", network: "egress", dockerRuntime: "runsc" });
  assert.equal(flag(args, "--network"), "egress");
  assert.equal(flag(args, "--runtime"), "runsc");
  assert.ok(args.includes("python:3.13-alpine"));
});

test("unknown runtimes are refused", () => {
  assert.throws(() => dockerArgs({ runtime: "bash", name: "a", context: "{}" }), /Unknown runtime/);
});

test("secrets are named in the args but their values are not", () => {
  const args = dockerArgs({ runtime: "python", name: "a", context: "{}", secretNames: ["API_TOKEN", "DB_URL"] });
  assert.ok(args.includes("OPENCRON_SECRET_NAMES=API_TOKEN,DB_URL"));
  const passed = args.filter((arg, i) => args[i - 1] === "--env" && !arg.includes("="));
  assert.deepEqual(passed, ["API_TOKEN", "DB_URL"]);
  // the image and command come after every --env
  assert.ok(args.lastIndexOf("--env") < args.indexOf("--entrypoint"));
});

test("a run without secrets names none", () => {
  const args = dockerArgs({ runtime: "javascript", name: "a", context: "{}" });
  assert.ok(!args.some((arg) => arg.startsWith("OPENCRON_SECRET_NAMES=")));
});
