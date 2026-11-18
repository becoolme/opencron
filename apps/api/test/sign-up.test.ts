import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/app";
import { signUpMode } from "../src/sign-up";
import { nodeConfig } from "../src/node-config";
import { applyMigrations, createTestAccount, type TestAccount } from "./helpers";

const closed = { ...env, SIGNUP: "closed" };
const signUp = (bindings: typeof env, email = `late-${crypto.randomUUID()}@example.com`) => app.request("https://w/api/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://cron.example.com" },
  body: JSON.stringify({ name: "Late", email, password: "opencron-test-password" }),
}, bindings);
const instance = async (bindings: typeof env, query = "") => (await app.request(`https://w/api/instance${query}`, {}, bindings)).json();

let first: TestAccount;
beforeAll(async () => {
  await applyMigrations();
  first = await createTestAccount("first");
});

async function invite(email: string, expiresInMs: number): Promise<string> {
  const id = `inv_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId")
     VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?)`,
  ).bind(id, `ws_${first.userId}`, email, new Date(Date.now() + expiresInMs).toISOString(), new Date().toISOString(), first.userId).run();
  return id;
}

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

  it("still lets someone with a pending invitation sign up when closed", async () => {
    const email = `invited-${crypto.randomUUID()}@example.com`;
    const id = await invite(email, 60_000);
    expect(await instance(closed, `?invite=${id}`)).toEqual({ sign_up: true });
    expect(await instance(closed, "?invite=inv_unknown")).toEqual({ sign_up: false });
    expect((await signUp(closed, email.toUpperCase())).status).toBe(200);

    const late = `expired-${crypto.randomUUID()}@example.com`;
    const expired = await invite(late, -1000);
    expect(await instance(closed, `?invite=${expired}`)).toEqual({ sign_up: false });
    expect((await signUp(closed, late)).status).toBe(403);
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
