import { describe, expect, it } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";

// Storage is isolated per test file, so this file can build its own database from the earlier migrations.
describe("migration 0010 (workspaces)", () => {
  it("moves each account's jobs, secrets, keys and sessions into a personal workspace", async () => {
    const before = env.TEST_MIGRATIONS.filter((migration) => migration.name < "0010");
    const after = env.TEST_MIGRATIONS.filter((migration) => migration.name >= "0010");
    expect(after[0]!.name).toMatch(/^0010_workspaces/);
    await applyD1Migrations(env.DB, before);

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO "user" (id, name, email, createdAt, updatedAt) VALUES ('u1', 'Ann', 'ann@example.com', ?, ?)`).bind("2025-01-01T00:00:00.000Z", now),
      env.DB.prepare(`INSERT INTO "user" (id, name, email, createdAt, updatedAt) VALUES ('u2', 'Ben', 'ben@example.com', ?, ?)`).bind("2025-02-01T00:00:00.000Z", now),
      env.DB.prepare(`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s1', ?, 't1', ?, ?, 'u2')`).bind(now, now, now),
      env.DB.prepare(`INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at, created_at, updated_at, owner_user_id)
        VALUES ('ben', 'https://a.b', 'GET', '0 12 * * *', 1, 30000, 0, 0, 0, 'u2')`),
      env.DB.prepare(`INSERT INTO jobs (name, url, method, cron, enabled, timeout_ms, next_run_at, created_at, updated_at, owner_user_id)
        VALUES ('legacy', 'https://a.b', 'GET', '0 12 * * *', 1, 30000, 0, 0, 0, NULL)`),
      env.DB.prepare(`INSERT INTO secrets (owner_user_id, name, value, created_at, updated_at) VALUES ('u2', 'TOKEN', 'v1:x', 0, 0)`),
      env.DB.prepare(`INSERT INTO api_keys (id, owner_user_id, name, prefix, key_hash, scope, created_at) VALUES ('k1', 'u2', 'k', 'oc_abcd', 'h', 'read', 0)`),
    ]);

    await applyD1Migrations(env.DB, after);

    const workspaces = await env.DB.prepare("SELECT id, name FROM organization ORDER BY id").all();
    expect(workspaces.results).toEqual([{ id: "ws_u1", name: "Ann" }, { id: "ws_u2", name: "Ben" }]);
    expect((await env.DB.prepare("SELECT organizationId, userId, role FROM member ORDER BY id").all()).results).toEqual([
      { organizationId: "ws_u1", userId: "u1", role: "owner" },
      { organizationId: "ws_u2", userId: "u2", role: "owner" },
    ]);
    expect((await env.DB.prepare("SELECT name, owner_user_id, organization_id, project_id FROM jobs ORDER BY name").all()).results).toEqual([
      { name: "ben", owner_user_id: "u2", organization_id: "ws_u2", project_id: "pj_u2" },
      // a job from before accounts goes to the first account
      { name: "legacy", owner_user_id: "u1", organization_id: "ws_u1", project_id: "pj_u1" },
    ]);
    expect(await env.DB.prepare("SELECT organization_id FROM secrets WHERE name = 'TOKEN'").first()).toEqual({ organization_id: "ws_u2" });
    expect(await env.DB.prepare("SELECT organization_id FROM api_keys WHERE id = 'k1'").first()).toEqual({ organization_id: "ws_u2" });
    expect(await env.DB.prepare("SELECT activeOrganizationId FROM session WHERE id = 's1'").first()).toEqual({ activeOrganizationId: "ws_u2" });
  });
});
