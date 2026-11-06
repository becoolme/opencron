import type { Env } from "./types";

/**
 * Who may create an account. "open" (the default) lets anyone sign up; "closed" allows only the first account, so a new
 * deployment can still be set up, and refuses every sign-up after it.
 */
export function signUpMode(env: Pick<Env, "SIGNUP">): "open" | "closed" {
  const mode = (env.SIGNUP || "open").trim().toLowerCase();
  if (mode === "open" || mode === "closed") return mode;
  throw new Error(`SIGNUP must be "open" or "closed", not "${env.SIGNUP}"`);
}
