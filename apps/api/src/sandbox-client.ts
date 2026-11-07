import type { Env, ScriptRuntime } from "./types";

export interface SandboxRun {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
}

export interface SandboxRequest {
  runtime: ScriptRuntime;
  source: string;
  timeout_ms: number;
  context: Record<string, unknown>;
  /** The account the job belongs to; the sandbox limits how many of its slots one account holds. */
  owner?: string;
  /** The account's secrets, set as environment variables in the container. */
  env?: Record<string, string>;
}

type SandboxSettings = Pick<Env, "SANDBOX_URL" | "SANDBOX_TOKEN" | "SANDBOX_ACCESS_CLIENT_ID" | "SANDBOX_ACCESS_CLIENT_SECRET">;

/** Hosts plain HTTP may reach: loopback, a Compose service name, or a private IPv4 address. */
function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || !hostname.includes(".")) return true;
  const ip = hostname.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Where to send script runs and the headers that authenticate them. A sandbox on another network (the Cloudflare
 * deployment always has one) must be reached over HTTPS: the account's secrets travel with every run.
 */
export function sandboxRequestTarget(env: SandboxSettings): { url: URL; headers: Record<string, string> } {
  if (!env.SANDBOX_URL) throw new Error("No sandbox is configured for this deployment");
  if (!env.SANDBOX_TOKEN) throw new Error("SANDBOX_TOKEN is not set");
  if (env.SANDBOX_TOKEN.length < 16 || /^change-me/i.test(env.SANDBOX_TOKEN)) {
    throw new Error("SANDBOX_TOKEN is a placeholder or too short");
  }
  let base: URL;
  try {
    base = new URL(env.SANDBOX_URL);
  } catch {
    throw new Error("SANDBOX_URL is not a valid URL");
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && isPrivateHost(base.hostname))) {
    throw new Error("SANDBOX_URL must use https unless the sandbox is on a private network");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.SANDBOX_TOKEN}`,
  };
  const { SANDBOX_ACCESS_CLIENT_ID: accessId, SANDBOX_ACCESS_CLIENT_SECRET: accessSecret } = env;
  if (Boolean(accessId) !== Boolean(accessSecret)) {
    throw new Error("Set both SANDBOX_ACCESS_CLIENT_ID and SANDBOX_ACCESS_CLIENT_SECRET, or neither");
  }
  if (accessId && accessSecret) {
    // a Cloudflare Access service token, for a sandbox published through a tunnel behind Access
    headers["cf-access-client-id"] = accessId;
    headers["cf-access-client-secret"] = accessSecret;
  }
  return { url: new URL("/run", base), headers };
}

/**
 * Runs a script in the sandbox service (apps/sandbox). The URL comes from the operator's configuration, never from a
 * user, so this is a plain fetch rather than guardedFetch: the service sits on the deployment's private network, or
 * behind HTTPS and its token when the app runs on Cloudflare.
 */
export async function runInSandbox(env: SandboxSettings, request: SandboxRequest): Promise<SandboxRun> {
  const { url, headers } = sandboxRequestTarget(env);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    // container start, image setup and teardown come on top of the script's own timeout
    signal: AbortSignal.timeout(request.timeout_ms + 30_000),
  });
  const body = await res.json().catch(() => null) as (SandboxRun & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(`Sandbox refused the run: ${body?.error ?? `HTTP ${res.status}`}`);
  return body;
}

/** The tail of a stream, where the error usually is. */
export function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
