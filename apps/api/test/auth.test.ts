import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { applyMigrations, createTestAccount } from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

describe("Better Auth", () => {
  it("rejects protected API requests without a session", async () => {
    const response = await SELF.fetch("https://w/api/jobs");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("registers a user, sets a session cookie, and authorizes API requests", async () => {
    const account = await createTestAccount("registration");

    expect(account.headers.cookie).toMatch(/session_token=/);
    const response = await SELF.fetch("https://w/api/jobs", { headers: account.headers });
    expect(response.status).toBe(200);
  });

  it("rejects an incorrect password", async () => {
    const account = await createTestAccount("wrong-password");
    const response = await SELF.fetch("https://w/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://cron.example.com" },
      body: JSON.stringify({ email: account.email, password: "definitely-wrong" }),
    });

    expect(response.status).toBe(401);
  });

  it("signs in with email and password", async () => {
    const account = await createTestAccount("sign-in");
    const response = await SELF.fetch("https://w/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://cron.example.com" },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/session_token=/);
  });

  it("invalidates the current session on sign out", async () => {
    const account = await createTestAccount("sign-out");
    const signOut = await SELF.fetch("https://w/api/auth/sign-out", {
      method: "POST",
      headers: { ...account.headers, origin: "https://cron.example.com" },
    });
    expect(signOut.status).toBe(200);

    const response = await SELF.fetch("https://w/api/jobs", { headers: account.headers });
    expect(response.status).toBe(401);
  });
});
