/**
 * The Docker API guard's policy. The fixture is the container create body the docker CLI sends for a real sandbox run
 * (captured from `docker run` with the flags in docker-args.mjs), so a CLI that changes its body shows up here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DEFAULT_IMAGES } from "../src/docker-args.mjs";
import { Refused, classify, normalizeImage, sanitizeCreate } from "../src/docker-policy.mjs";

const CLI_BODY = JSON.parse(readFileSync(new URL("./fixtures/cli-create.json", import.meta.url), "utf8"));
const images = new Set(["python:3.12-alpine", "node:22-alpine@sha256:" + "a".repeat(64)].map(normalizeImage));
const policy = { images, network: "none", runtime: undefined };
const body = (change = () => {}) => {
  const copy = structuredClone(CLI_BODY);
  change(copy);
  return copy;
};
const refused = (fn, pattern) => assert.throws(fn, (error) => error instanceof Refused && (!pattern || pattern.test(error.message)));

describe("default images", () => {
  test("are pinned by digest", () => {
    for (const image of Object.values(DEFAULT_IMAGES)) assert.match(image, /^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });
});

describe("classify", () => {
  const call = (method, url) => classify(method, url, policy);

  test("lets the calls of a sandbox run through", () => {
    assert.equal(call("HEAD", "/_ping").kind, "ping");
    assert.equal(call("GET", "/v1.54/version").kind, "ping");
    assert.equal(call("GET", "/v1.54/images/python:3.12-alpine/json").kind, "image-inspect");
    assert.equal(call("GET", "/v1.54/images/docker.io%2Flibrary%2Fpython:3.12-alpine/json").kind, "image-inspect");
    assert.equal(call("POST", "/v1.54/images/create?fromImage=docker.io%2Flibrary%2Fpython&tag=3.12-alpine").kind, "image-pull");
    assert.equal(call("POST", `/v1.54/images/create?fromImage=node&tag=sha256%3A${"a".repeat(64)}`).kind, "image-pull");
    assert.deepEqual(call("POST", "/v1.54/containers/create?name=opencron-run-0123456789abcdef"),
      { kind: "create", name: "opencron-run-0123456789abcdef" });
    for (const [method, action] of [["POST", "attach"], ["POST", "start"], ["POST", "wait"], ["POST", "kill"], ["GET", "json"]]) {
      assert.deepEqual(call(method, `/v1.54/containers/opencron-run-0123456789abcdef/${action}?x=1`),
        { kind: "container", ref: "opencron-run-0123456789abcdef", action });
    }
    assert.equal(call("DELETE", "/v1.54/containers/abc").action, "remove");
  });

  test("refuses everything else", () => {
    for (const [method, url] of [
      ["GET", "/v1.54/containers/json"],
      ["GET", "/v1.54/images/json"],
      ["GET", "/v1.54/images/alpine:latest/json"],
      ["POST", "/v1.54/images/create?fromImage=alpine&tag=latest"],
      ["POST", "/v1.54/images/create?fromImage=python&tag=3.12-alpine&fromSrc=-"],
      ["POST", "/v1.54/images/create?fromImage=node&tag=22-alpine"],
      ["POST", "/v1.54/containers/create?name=evil"],
      ["POST", "/v1.54/containers/create"],
      ["POST", "/v1.54/containers/create?name=opencron-run-0123456789abcdef&extra=1"],
      ["POST", "/v1.54/containers/abc/exec"],
      ["POST", "/v1.54/containers/abc/update"],
      ["PUT", "/v1.54/containers/abc/archive?path=/"],
      ["GET", "/v1.54/containers/abc/archive?path=/"],
      ["POST", "/v1.54/containers/abc"],
      ["POST", "/v1.54/volumes/create"],
      ["POST", "/v1.54/networks/create"],
      ["POST", "/v1.54/build"],
      ["GET", "/v1.54/info"],
      ["POST", "/v1.54/swarm/init"],
      ["POST", "/v1.54/plugins/pull"],
      ["GET", "/v1.54/events"],
    ]) {
      refused(() => call(method, url), undefined);
    }
  });
});

describe("sanitizeCreate", () => {
  test("accepts the body the docker CLI sends for a run", () => {
    const out = sanitizeCreate(body(), policy);
    assert.equal(out.Image, "python:3.12-alpine");
    assert.equal(out.User, "65534:65534");
    assert.deepEqual(out.Cmd, CLI_BODY.Cmd);
    assert.deepEqual(out.Env, CLI_BODY.Env);
    assert.equal(out.HostConfig.Memory, 536870912);
    assert.equal(out.HostConfig.NetworkMode, "none");
  });

  test("forces the hardening and drops every field it did not check", () => {
    const out = sanitizeCreate(body((b) => {
      b.HostConfig.MaskedPaths = [];
      b.HostConfig.ReadonlyPaths = [];
      b.HostConfig.ReadonlyRootfs = false;
      b.HostConfig.AutoRemove = false;
      b.HostConfig.CapDrop = [];
      b.HostConfig.IpcMode = "";
      b.HostConfig.SecurityOpt = [];
    }), policy);
    assert.equal(out.HostConfig.ReadonlyRootfs, true);
    assert.equal(out.HostConfig.AutoRemove, true);
    assert.deepEqual(out.HostConfig.CapDrop, ["ALL"]);
    assert.equal(out.HostConfig.IpcMode, "none");
    assert.deepEqual(out.HostConfig.SecurityOpt, ["no-new-privileges"]);
    // left unset, the daemon masks /proc and /sys as usual
    assert.ok(!("MaskedPaths" in out.HostConfig) && !("ReadonlyPaths" in out.HostConfig));
    assert.ok(!("Privileged" in out.HostConfig) && !("Binds" in out.HostConfig));
    assert.deepEqual(Object.keys(out).sort(), ["AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Entrypoint", "Env",
      "HostConfig", "Image", "Labels", "NetworkingConfig", "OpenStdin", "StdinOnce", "Tty", "User", "WorkingDir"]);
  });

  test("sets the configured runtime", () => {
    assert.equal(sanitizeCreate(body(), { ...policy, runtime: "runsc" }).HostConfig.Runtime, "runsc");
    assert.equal(sanitizeCreate(body((b) => { b.HostConfig.Runtime = "runsc"; }), { ...policy, runtime: "runsc" }).HostConfig.Runtime, "runsc");
    refused(() => sanitizeCreate(body((b) => { b.HostConfig.Runtime = "runc"; }), { ...policy, runtime: "runsc" }));
  });

  const escapes = {
    "a privileged container": (b) => { b.HostConfig.Privileged = true; },
    "a host bind": (b) => { b.HostConfig.Binds = ["/:/host"]; },
    "a mount": (b) => { b.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/host" }]; },
    "a volume from another container": (b) => { b.HostConfig.VolumesFrom = ["opencron-app-1"]; },
    "the host network": (b) => { b.HostConfig.NetworkMode = "host"; },
    "another container's network": (b) => { b.HostConfig.NetworkMode = "container:opencron-postgres-1"; },
    "a bridge network": (b) => { b.HostConfig.NetworkMode = "bridge"; },
    "an extra network endpoint": (b) => { b.NetworkingConfig = { EndpointsConfig: { internal: {} } }; },
    "the host pid namespace": (b) => { b.HostConfig.PidMode = "host"; },
    "the host user namespace": (b) => { b.HostConfig.UsernsMode = "host"; },
    "an added capability": (b) => { b.HostConfig.CapAdd = ["SYS_ADMIN"]; },
    "a device": (b) => { b.HostConfig.Devices = [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda", CgroupPermissions: "rwm" }]; },
    "unconfined seccomp": (b) => { b.HostConfig.SecurityOpt = ["seccomp=unconfined"]; },
    "unconfined apparmor": (b) => { b.HostConfig.SecurityOpt = ["no-new-privileges", "apparmor=unconfined"]; },
    "a published port": (b) => { b.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "80" }] }; },
    "another image": (b) => { b.Image = "alpine:latest"; },
    "the root user": (b) => { b.User = "0:0"; },
    "no user": (b) => { delete b.User; },
    "a terminal": (b) => { b.Tty = true; },
    "no memory limit": (b) => { b.HostConfig.Memory = 0; },
    "too much memory": (b) => { b.HostConfig.Memory = 8 * 1024 ** 3; b.HostConfig.MemorySwap = 8 * 1024 ** 3; },
    "swap": (b) => { b.HostConfig.MemorySwap = -1; },
    "no process limit": (b) => { b.HostConfig.PidsLimit = -1; },
    "too many processes": (b) => { b.HostConfig.PidsLimit = 4096; },
    "more than one CPU": (b) => { b.HostConfig.NanoCpus = 4e9; },
    "a second tmpfs": (b) => { b.HostConfig.Tmpfs["/etc"] = "rw,size=1m"; },
    "a tmpfs without nosuid": (b) => { b.HostConfig.Tmpfs["/tmp"] = "rw,nodev,size=256m"; },
    "a tmpfs without a size": (b) => { b.HostConfig.Tmpfs["/tmp"] = "rw,nosuid,nodev"; },
    "a tmpfs with other options": (b) => { b.HostConfig.Tmpfs["/tmp"] = "rw,nosuid,nodev,size=1m,uid=0"; },
    "a raised ulimit": (b) => { b.HostConfig.Ulimits = [{ Name: "nofile", Soft: 65536, Hard: 65536 }]; },
    "another ulimit": (b) => { b.HostConfig.Ulimits = [{ Name: "memlock", Soft: 1, Hard: 1 }]; },
    "a restart policy": (b) => { b.HostConfig.RestartPolicy = { Name: "always" }; },
    "a log driver": (b) => { b.HostConfig.LogConfig = { Type: "json-file" }; },
    "a cgroup parent": (b) => { b.HostConfig.CgroupParent = "/"; },
    "an OOM-kill exemption": (b) => { b.HostConfig.OomKillDisable = true; },
    "a sysctl": (b) => { b.HostConfig.Sysctls = { "kernel.core_pattern": "|/tmp/x" }; },
    "a field written in other case": (b) => { b.HostConfig.privileged = true; },
    "a top-level field written in other case": (b) => { b.hostconfig = { Privileged: true }; },
    "an unknown top-level field": (b) => { b.Healthcheck = { Test: ["CMD", "sh"] }; },
    "a non-string label": (b) => { b.Labels = { a: 1 }; },
    "a non-string command": (b) => { b.Cmd = [1]; },
  };
  for (const [label, change] of Object.entries(escapes)) {
    test(`refuses ${label}`, () => refused(() => sanitizeCreate(body(change), policy)));
  }

  test("refuses what is not an object", () => {
    for (const input of [null, [], "x", 1]) refused(() => sanitizeCreate(input, policy));
    refused(() => sanitizeCreate(body((b) => { b.HostConfig = []; }), policy));
  });
});
