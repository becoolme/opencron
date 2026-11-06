/**
 * Stands in for the docker CLI in the sandbox server tests. Each call is appended to $FAKE_DOCKER_LOG as one JSON line.
 * A `docker run` acts on the script it receives on stdin:
 *   echo       prints the arguments, the script and the bare `--env NAME` values it would pass on, as JSON
 *   fail       writes "boom" to stderr and exits 3
 *   flood      writes 200 KB to stdout and to stderr
 *   hang       never exits
 *   slow:<ms>  exits 0 after that long
 */
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const missing = (process.env.FAKE_DOCKER_MISSING ?? "").split(",").filter(Boolean);

if (args[0] === "image" && args[1] === "inspect") {
  log({ cmd: "inspect", image: args[2] });
  process.exit(missing.includes(args[2]) ? 1 : 0);
}
if (args[0] === "pull" || args[0] === "kill") {
  log({ cmd: args[0], target: args[1] });
  process.exit(0);
}
if (args[0] !== "run") {
  process.stderr.write(`fake docker: unsupported ${args[0]}`);
  process.exit(125);
}

let source = "";
for await (const chunk of process.stdin) source += chunk;
log({ cmd: "run", args, source: source.slice(0, 100) });

if (source === "echo") {
  // `--env NAME` without a value takes it from this process's environment, as the real CLI does
  const passed = {};
  args.forEach((arg, i) => { if (arg === "--env" && !args[i + 1].includes("=")) passed[args[i + 1]] = process.env[args[i + 1]] ?? null; });
  process.stdout.write(JSON.stringify({ args, source, env: passed, sandboxToken: process.env.SANDBOX_TOKEN ?? null }));
} else if (source === "fail") {
  process.stderr.write("boom");
  process.exitCode = 3;
} else if (source === "flood") {
  process.stdout.write("o".repeat(200 * 1024));
  process.stderr.write("e".repeat(200 * 1024));
} else if (source === "hang") {
  setInterval(() => {}, 1_000);
} else if (source.startsWith("slow:")) {
  await new Promise((resolve) => setTimeout(resolve, Number(source.slice(5))));
  log({ cmd: "done" });
}
