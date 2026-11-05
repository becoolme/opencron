/**
 * Builds the `docker run` argument list for one script run. Pure, so the hardening flags can be tested without Docker.
 *
 * Every run gets a fresh container that has no network, a read-only root, no Linux capabilities, a non-root user, and
 * fixed memory, CPU and process limits. The script arrives on stdin and is written to a size-limited tmpfs.
 */

export const RUNTIMES = ["javascript", "python", "go"];

export const DEFAULT_IMAGES = {
  javascript: "node:22-alpine",
  python: "python:3.12-alpine",
  go: "golang:1.23-alpine",
};

// Imports the user's module and calls it the way the Cloudflare runtime would: `default.fetch(request, env, ctx)` or a
// default function. The response body becomes stdout and a non-2xx status a failed run.
export const NODE_HARNESS = `
const mod = await import("/tmp/main.mjs");
const entry = mod.default;
const context = process.env.OPENCRON_CONTEXT ?? "{}";
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
let res;
if (entry && typeof entry.fetch === "function") {
  res = await entry.fetch(new Request("https://opencron.internal/run", { method: "POST", body: context, headers: { "content-type": "application/json" } }), {}, ctx);
} else if (typeof entry === "function") {
  res = await entry(JSON.parse(context), {}, ctx);
} else {
  throw new Error("The script must export default { fetch } or a default function");
}
await Promise.allSettled(waits);
if (res instanceof Response) {
  process.stdout.write(await res.text());
  process.exitCode = res.ok ? 0 : 1;
} else if (res !== undefined) {
  process.stdout.write(typeof res === "string" ? res : JSON.stringify(res));
}
`;

const PROFILES = {
  javascript: {
    memory: "512m",
    tmpfs: "/tmp:rw,noexec,nosuid,nodev,size=256m",
    command: 'cat > /tmp/main.mjs && exec node --input-type=module -e "$OPENCRON_HARNESS"',
    env: (harness) => ({ OPENCRON_HARNESS: harness, NODE_OPTIONS: "--max-old-space-size=384" }),
  },
  python: {
    memory: "512m",
    tmpfs: "/tmp:rw,noexec,nosuid,nodev,size=256m",
    command: "cat > /tmp/main.py && exec python3 -I -B /tmp/main.py",
    env: () => ({ PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" }),
  },
  go: {
    // the compiler writes and runs a binary, so this tmpfs has to allow exec
    memory: "1g",
    tmpfs: "/tmp:rw,exec,nosuid,nodev,size=512m",
    command: "mkdir -p /tmp/src && cat > /tmp/src/main.go && cd /tmp/src && exec go run main.go",
    env: () => ({
      GOCACHE: "/tmp/.cache",
      GOPATH: "/tmp/go",
      GOTMPDIR: "/tmp",
      GOTOOLCHAIN: "local",
      GOPROXY: "off",
      GO111MODULE: "off",
      CGO_ENABLED: "0",
      // Go sizes its build and its threads by the host's CPUs, not the container's one, and runs out of the 64
      // processes the container may start; keep both to the single CPU the run is given
      GOFLAGS: "-p=1",
      GOMAXPROCS: "1",
    }),
  },
};

/**
 * @param {{ runtime: string, name: string, context: string, image?: string, network?: string, dockerRuntime?: string }} options
 * @returns {string[]}
 */
export function dockerArgs({ runtime, name, context, image, network, dockerRuntime }) {
  const profile = PROFILES[runtime];
  if (!profile) throw new Error(`Unknown runtime: ${runtime}`);
  const env = { HOME: "/tmp", OPENCRON_CONTEXT: context, ...profile.env(NODE_HARNESS) };
  const args = [
    "run", "--rm", "-i",
    "--name", name,
    "--pull", "never",
    "--network", network || "none",
    "--read-only",
    "--tmpfs", profile.tmpfs,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", profile.memory,
    "--memory-swap", profile.memory,
    "--cpus", "1",
    "--ipc", "none",
    "--user", "65534:65534",
    "--ulimit", "nofile=256:256",
    "--ulimit", "fsize=268435456",
    "--workdir", "/tmp",
    "--log-driver", "none",
  ];
  if (dockerRuntime) args.push("--runtime", dockerRuntime);
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  args.push("--entrypoint", "/bin/sh", image || DEFAULT_IMAGES[runtime], "-c", profile.command);
  return args;
}
