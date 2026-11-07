import { signUpMode } from "./sign-up";
import type { Env } from "./types";

/**
 * Reads the self-hosted (Docker) configuration from the process environment and refuses to start on a setup that would
 * be unsafe. The placeholders from .env.docker.example must never reach a running deployment: they would let anyone
 * forge sessions or submit code to the sandbox.
 */
export function nodeConfig(vars: Record<string, string | undefined>): { env: Env; port: number; warnings: string[] } {
  const need = (key: string): string => {
    const value = vars[key];
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  for (const key of ["BETTER_AUTH_SECRET", "SANDBOX_TOKEN"]) {
    const value = vars[key];
    if (value && (/^change-me/i.test(value) || value.length < 16)) {
      throw new Error(`${key} is a placeholder or too short: generate one with \`openssl rand -hex 32\``);
    }
  }
  const port = Number(vars.PORT ?? 8080);
  const env: Env = {
    DB_PROVIDER: "postgres",
    DATABASE_URL: need("DATABASE_URL"),
    BETTER_AUTH_SECRET: need("BETTER_AUTH_SECRET"),
    APP_URL: vars.APP_URL || `http://localhost:${port}`,
    ALLOW_PRIVATE_TARGETS: vars.ALLOW_PRIVATE_TARGETS,
    SANDBOX_URL: vars.SANDBOX_URL || undefined,
    SANDBOX_TOKEN: vars.SANDBOX_TOKEN || undefined,
    SANDBOX_ACCESS_CLIENT_ID: vars.SANDBOX_ACCESS_CLIENT_ID || undefined,
    SANDBOX_ACCESS_CLIENT_SECRET: vars.SANDBOX_ACCESS_CLIENT_SECRET || undefined,
    SIGNUP: vars.SIGNUP || undefined,
  };
  signUpMode(env);
  if (env.SANDBOX_URL && !env.SANDBOX_TOKEN) throw new Error("SANDBOX_TOKEN is required when SANDBOX_URL is set");
  const warnings = env.SANDBOX_URL ? [] : ["SANDBOX_URL is not set: script jobs cannot run on this deployment"];
  return { env, port, warnings };
}
