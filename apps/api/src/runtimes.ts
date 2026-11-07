import type { Env, ScriptRuntime } from "./types";

export const SCRIPT_RUNTIMES: readonly ScriptRuntime[] = ["javascript", "python", "go"];

export function isScriptRuntime(value: unknown): value is ScriptRuntime {
  return typeof value === "string" && (SCRIPT_RUNTIMES as readonly string[]).includes(value);
}

/**
 * Languages this deployment can run. On Cloudflare the Worker Loader runs JavaScript. A deployment with a sandbox
 * service (bundled with Docker, or on a server of your own next to Cloudflare) runs every runtime in a container;
 * JavaScript keeps using the Worker Loader where both exist.
 */
export function availableRuntimes(env: Pick<Env, "SANDBOX_URL">): ScriptRuntime[] {
  return env.SANDBOX_URL ? [...SCRIPT_RUNTIMES] : ["javascript"];
}
