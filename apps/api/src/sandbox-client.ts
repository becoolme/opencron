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
}

/**
 * Runs a script in the sandbox service (apps/sandbox). The URL comes from the operator's configuration, never from a
 * user, so this is a plain fetch rather than guardedFetch: the service sits on the deployment's private network.
 */
export async function runInSandbox(env: Pick<Env, "SANDBOX_URL" | "SANDBOX_TOKEN">, request: SandboxRequest): Promise<SandboxRun> {
  if (!env.SANDBOX_URL) throw new Error("No sandbox is configured for this deployment");
  if (!env.SANDBOX_TOKEN) throw new Error("SANDBOX_TOKEN is not set");
  const res = await fetch(new URL("/run", env.SANDBOX_URL), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.SANDBOX_TOKEN}` },
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
