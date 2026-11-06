import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/app";
import { signUpMode } from "../src/sign-up";
import { nodeConfig } from "../src/node-config";
import { applyMigrations, createTestAccount } from "./helpers";

const closed = { ...env, SIGNUP: "closed" };
const signUp = (bindings: typeof env) => app.request("https://w/api/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://cron.example.com" },
  body: JSON.stringify({ name: "Late", email: `late-${crypto.randomUUID()}@example.com`, password: "opencron-test-password" }),
}, bindings);
const instance = async (bindings: typeof env) => (await app.request("https://w/api/instance", {}, bindings)).json();

beforeAll(async () => {
  await applyMigrations();
  await createTestAccount("first");
});

describe("SIGNUP", () => {
  it("lets anyone sign up when open", async () => {
    expect((await signUp(env)).status).toBe(200);
    expect(await instance(env)).toEqual({ sign_up: true });
  });

  it("refuses sign-ups after the first account when closed", async () => {
    const response = await signUp(closed);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: "Sign-up is closed on this deployment" });
    expect(await instance(closed)).toEqual({ sign_up: false });
  });

  it("accepts only open or closed", () => {
    expect(signUpMode({})).toBe("open");
    expect(signUpMode({ SIGNUP: " Closed " })).toBe("closed");
    expect(() => signUpMode({ SIGNUP: "invite" })).toThrow(/SIGNUP must be/);
    const base = { DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "0123456789abcdef0123" };
    expect(nodeConfig({ ...base, SIGNUP: "closed" }).env.SIGNUP).toBe("closed");
    expect(() => nodeConfig({ ...base, SIGNUP: "yes" })).toThrow(/SIGNUP must be/);
  });
});
