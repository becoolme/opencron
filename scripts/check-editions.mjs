#!/usr/bin/env node
// `main` is the open-source edition and is published. The hosted edition lives on the `cloud` branch, which merges
// `main` and is never merged back. This fails when hosted-only files, or imports of them, show up on `main`.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLOUD_ONLY_PATHS = [
  "apps/api/src/cloud",
  "apps/api/wrangler.cloud.toml",
  "packages/stripe-billing",
];
const hostedSpecifier = /(^|\/)cloud(\/|$)|wrangler\.cloud|@openuptime\/stripe-billing/;

const branch = () => {
  const target = process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME;
  if (target) return target;
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};

if (/^cloud/.test(branch())) {
  console.log("Hosted branch: edition boundary not checked.");
  process.exit(0);
}

const walk = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|vue|mjs|js)$/.test(name) ? [p] : [];
      });
const specifiers = (src) =>
  [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1]);

const problems = CLOUD_ONLY_PATHS.filter((p) => existsSync(join(ROOT, p))).map((p) => `${p} is hosted-only`);
for (const f of [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))]) {
  for (const spec of specifiers(readFileSync(f, "utf8"))) {
    if (hostedSpecifier.test(spec)) problems.push(`${relative(ROOT, f)} imports ${spec}`);
  }
}
if (problems.length) {
  console.error(`Hosted-only code on the community edition:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("Community edition holds no hosted-only code.");
