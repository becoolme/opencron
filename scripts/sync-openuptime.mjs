#!/usr/bin/env node
// Vendors shared packages from an openuptime checkout into packages/<name>.
//
//   node scripts/sync-openuptime.mjs            copy every package listed in shared-packages.json
//   node scripts/sync-openuptime.mjs kit        copy one package
//   node scripts/sync-openuptime.mjs --check    fail if a vendored file was edited here (no checkout needed)
//
// The openuptime checkout defaults to the `source` in shared-packages.json; OPENUPTIME_DIR overrides it.
// Files are read from the git ref (not the working tree), so uncommitted openuptime edits never leak in.
// shared-packages.lock.json records the commit and a hash of every file that was copied.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "shared-packages.json");
const LOCK = join(ROOT, "shared-packages.lock.json");

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.filter((a) => !a.startsWith("--"));

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

if (check) {
  if (!existsSync(LOCK)) fail("shared-packages.lock.json is missing: run pnpm sync:openuptime");
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  const problems = [];
  for (const { name } of config.packages) {
    const entry = lock.packages[name];
    if (!entry) {
      problems.push(`${name}: listed in shared-packages.json but never synced`);
      continue;
    }
    const dir = join(ROOT, "packages", name);
    const local = existsSync(dir) ? walk(dir).map((f) => relative(dir, f)).sort() : [];
    for (const f of local) {
      if (!(f in entry.files)) problems.push(`packages/${name}/${f}: not in openuptime (add it there instead)`);
      else if (sha(readFileSync(join(dir, f))) !== entry.files[f]) problems.push(`packages/${name}/${f}: edited here (change it in openuptime, then sync)`);
    }
    for (const f of Object.keys(entry.files)) if (!local.includes(f)) problems.push(`packages/${name}/${f}: deleted here`);
  }
  for (const name of Object.keys(lock.packages)) {
    if (!config.packages.some((p) => p.name === name)) problems.push(`${name}: in the lock but not in shared-packages.json`);
  }
  if (problems.length) fail(`Vendored openuptime packages differ from their source:\n  ${problems.join("\n  ")}`);
  console.log(`Vendored packages match openuptime (${config.packages.map((p) => p.name).join(", ")}).`);
  process.exit(0);
}

const source = resolve(ROOT, process.env.OPENUPTIME_DIR ?? config.source);
if (!existsSync(join(source, ".git"))) fail(`No openuptime checkout at ${source} (set OPENUPTIME_DIR)`);
const git = (...a) => execFileSync("git", ["-C", source, ...a], { maxBuffer: 64 * 1024 * 1024 });

const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : { packages: {} };
for (const { name, ref } of config.packages) {
  if (only.length && !only.includes(name)) continue;
  const commit = git("rev-parse", `${ref}^{commit}`).toString().trim();
  const prefix = `packages/${name}/`;
  const paths = git("ls-tree", "-r", "--name-only", commit, prefix).toString().split("\n").filter(Boolean);
  if (!paths.length) fail(`${prefix} does not exist at ${ref} (${commit.slice(0, 10)})`);
  const dir = join(ROOT, "packages", name);
  rmSync(dir, { recursive: true, force: true });
  const files = {};
  for (const p of paths) {
    const buf = git("show", `${commit}:${p}`);
    const rel = p.slice(prefix.length);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), buf);
    files[rel] = sha(buf);
  }
  lock.packages[name] = { ref, commit, files };
  console.log(`packages/${name}: ${paths.length} files from ${ref} @ ${commit.slice(0, 10)}`);
}
for (const name of Object.keys(lock.packages)) {
  if (!config.packages.some((p) => p.name === name)) delete lock.packages[name];
}
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
