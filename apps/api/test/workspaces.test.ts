import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applyMigrations, clearDb, createTestAccount, type TestAccount } from "./helpers";

let owner: TestAccount;
let admin: TestAccount;
let member: TestAccount;
let outsider: TestAccount;

beforeAll(async () => {
  await applyMigrations();
  owner = await createTestAccount("ws-owner");
  admin = await createTestAccount("ws-admin");
  member = await createTestAccount("ws-member");
  outsider = await createTestAccount("ws-outsider");
});
beforeEach(async () => { await clearDb(); });

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
async function call(account: TestAccount | null, path: string, init: Init = {}) {
  const response = await SELF.fetch(`https://w${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(account?.headers ?? { "content-type": "application/json" }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

/** A shared workspace owned by `owner`, with `admin` and `member` joined through invitations. */
async function sharedWorkspace() {
  const created = await call(owner, "/api/workspaces", { body: { name: "Team" } });
  expect(created.status).toBe(201);
  const workspaceId = created.body.workspace.id as string;
  const scope = { "x-workspace-id": workspaceId };
  for (const [account, role] of [[admin, "admin"], [member, "member"]] as const) {
    const invite = await call(owner, "/api/invitations", { body: { email: account.email, role }, headers: scope });
    expect(invite.status).toBe(201);
    expect(invite.body.invitation.url).toBe(`https://cron.example.com/app/invite/${invite.body.invitation.id}`);
    const accepted = await call(account, `/api/invite/${invite.body.invitation.id}/accept`, { body: {} });
    expect(accepted.status).toBe(200);
  }
  const projects = await call(owner, "/api/projects", { headers: scope });
  return { workspaceId, scope, defaultProject: projects.body.projects[0].id as string };
}

describe("workspaces", () => {
  it("gives every account a personal workspace with a Default project", async () => {
    const workspaces = await call(owner, "/api/workspaces");
    expect(workspaces.body.workspaces).toEqual([{ id: `ws_${owner.userId}`, name: "Test ws-owner", role: "owner" }]);
    expect(workspaces.body.current).toBe(`ws_${owner.userId}`);
    const projects = await call(owner, "/api/projects");
    expect(projects.body.projects.map((project: { name: string }) => project.name)).toEqual(["Default"]);
  });

  it("switches to a new workspace and back", async () => {
    const created = await call(owner, "/api/workspaces", { body: { name: "Side project" } });
    expect((await call(owner, "/api/workspaces")).body.current).toBe(created.body.workspace.id);
    await call(owner, `/api/workspaces/ws_${owner.userId}/activate`, { body: {} });
    expect((await call(owner, "/api/workspaces")).body.current).toBe(`ws_${owner.userId}`);
    expect((await call(outsider, `/api/workspaces/${created.body.workspace.id}/activate`, { body: {} })).status).toBe(404);
  });

  it("keeps jobs, secrets and keys apart between workspaces", async () => {
    const { scope } = await sharedWorkspace();
    await call(owner, "/api/jobs", { body: { name: "team job", cron: "0 12 * * *", url: "https://example.com" }, headers: scope });
    await call(owner, "/api/jobs", { body: { name: "personal job", cron: "0 12 * * *", url: "https://example.com" }, headers: { "x-workspace-id": `ws_${owner.userId}` } });
    await call(owner, "/api/secrets/TEAM_TOKEN", { method: "PUT", body: { value: "team-secret" }, headers: scope });

    const memberJobs = await call(member, "/api/jobs", { headers: scope });
    expect(memberJobs.body.jobs.map((job: { name: string }) => job.name)).toEqual(["team job"]);
    expect((await call(member, "/api/secrets", { headers: scope })).body.secrets.map((secret: { name: string }) => secret.name)).toEqual(["TEAM_TOKEN"]);
    expect((await call(owner, "/api/jobs", { headers: { "x-workspace-id": `ws_${owner.userId}` } })).body.jobs).toHaveLength(1);
    expect((await call(outsider, "/api/jobs", { headers: scope })).status).toBe(404);
    expect((await call(outsider, "/api/jobs")).body.jobs).toEqual([]);
  });

  it("lets only managers change settings, while members edit jobs", async () => {
    const { scope } = await sharedWorkspace();
    const job = await call(member, "/api/jobs", { body: { name: "member job", cron: "0 12 * * *", url: "https://example.com" }, headers: scope });
    expect(job.status).toBe(201);
    expect((await call(member, `/api/jobs/${job.body.job.id}`, { method: "PATCH", body: { name: "renamed" }, headers: scope })).status).toBe(200);

    for (const [path, init] of [
      ["/api/secrets/X", { method: "PUT", body: { value: "v" } }],
      ["/api/keys", { body: { name: "k" } }],
      ["/api/projects", { body: { name: "P" } }],
      ["/api/invitations", { body: { email: "new@example.com" } }],
      ["/api/workspaces/current", { method: "PATCH", body: { name: "Renamed" } }],
    ] as const) {
      expect((await call(member, path, { ...init, headers: scope })).status).toBe(403);
      expect((await call(admin, path, { ...init, headers: scope })).status).toBeLessThan(300);
    }
    expect((await call(admin, "/api/workspaces/current", { method: "DELETE", headers: scope })).status).toBe(403);
  });

  it("guards the owner role", async () => {
    const { scope } = await sharedWorkspace();
    const members = (await call(owner, "/api/members", { headers: scope })).body.members as { id: string; user_id: string; role: string }[];
    const id = (account: TestAccount) => members.find((row) => row.user_id === account.userId)!.id;

    expect((await call(admin, `/api/members/${id(member)}`, { method: "PATCH", body: { role: "owner" }, headers: scope })).status).toBe(403);
    expect((await call(admin, `/api/members/${id(owner)}`, { method: "DELETE", headers: scope })).status).toBe(403);
    expect((await call(owner, `/api/members/${id(owner)}`, { method: "PATCH", body: { role: "admin" }, headers: scope })).status).toBe(400);
    expect((await call(owner, `/api/members/${id(owner)}`, { method: "DELETE", headers: scope })).status).toBe(400);

    expect((await call(owner, `/api/members/${id(admin)}`, { method: "PATCH", body: { role: "owner" }, headers: scope })).status).toBe(200);
    expect((await call(owner, `/api/members/${id(owner)}`, { method: "PATCH", body: { role: "member" }, headers: scope })).status).toBe(200);
    // a member can leave on their own
    expect((await call(member, `/api/members/${id(member)}`, { method: "DELETE", headers: scope })).status).toBe(204);
    expect((await call(member, "/api/jobs", { headers: scope })).status).toBe(404);
  });

  it("deletes a workspace with everything in it", async () => {
    const { workspaceId, scope } = await sharedWorkspace();
    await call(owner, "/api/jobs", { body: { name: "team job", cron: "0 12 * * *", url: "https://example.com" }, headers: scope });
    expect((await call(owner, "/api/workspaces/current", { method: "DELETE", headers: scope })).status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ?").bind(workspaceId).first("n")).toBe(0);
    expect((await call(member, "/api/workspaces")).body.workspaces.map((row: { id: string }) => row.id)).toEqual([`ws_${member.userId}`]);
  });
});

describe("projects", () => {
  it("files jobs by project and filters by x-project-id", async () => {
    const { scope, defaultProject } = await sharedWorkspace();
    const api = (await call(owner, "/api/projects", { body: { name: "API" }, headers: scope })).body.project.id as string;
    expect((await call(owner, "/api/projects", { body: { name: "api" }, headers: scope })).status).toBe(409);

    // with two projects a new job needs one named
    const unnamed = await call(owner, "/api/jobs", { body: { name: "a", cron: "0 12 * * *", url: "https://example.com" }, headers: scope });
    expect(unnamed.status).toBe(400);
    await call(owner, "/api/jobs", { body: { name: "a", cron: "0 12 * * *", url: "https://example.com", project_id: api }, headers: scope });
    await call(owner, "/api/jobs", { body: { name: "b", cron: "0 12 * * *", url: "https://example.com" }, headers: { ...scope, "x-project-id": defaultProject } });

    const inApi = await call(owner, "/api/jobs", { headers: { ...scope, "x-project-id": api } });
    expect(inApi.body.jobs.map((job: { name: string }) => job.name)).toEqual(["a"]);
    expect((await call(owner, "/api/jobs", { headers: { ...scope, "x-project-id": "all" } })).body.jobs).toHaveLength(2);
    expect((await call(owner, "/api/jobs", { headers: { ...scope, "x-project-id": `pj_${outsider.userId}` } })).status).toBe(404);

    expect((await call(owner, `/api/projects/${api}`, { method: "DELETE", headers: scope })).status).toBe(400);
    const jobA = inApi.body.jobs[0].id;
    expect((await call(owner, `/api/jobs/${jobA}`, { method: "PATCH", body: { project_id: defaultProject }, headers: scope })).body.job.project_id).toBe(defaultProject);
    expect((await call(owner, `/api/projects/${api}`, { method: "DELETE", headers: scope })).status).toBe(204);
    expect((await call(owner, `/api/projects/${defaultProject}`, { method: "DELETE", headers: scope })).status).toBe(400);
  });

  it("limits an API key to its projects", async () => {
    const { scope, defaultProject } = await sharedWorkspace();
    const ops = (await call(owner, "/api/projects", { body: { name: "Ops" }, headers: scope })).body.project.id as string;
    await call(owner, "/api/jobs", { body: { name: "default job", cron: "0 12 * * *", url: "https://example.com", project_id: defaultProject }, headers: scope });
    await call(owner, "/api/jobs", { body: { name: "ops job", cron: "0 12 * * *", url: "https://example.com", project_id: ops }, headers: scope });

    const key = await call(owner, "/api/keys", { body: { name: "ops", scope: "write", project_ids: [ops] }, headers: scope });
    expect(key.status).toBe(201);
    const bearer = { authorization: `Bearer ${key.body.token}` };
    const jobs = await call(null, "/api/jobs", { headers: bearer });
    expect(jobs.body.jobs.map((job: { name: string }) => job.name)).toEqual(["ops job"]);
    // the only project it can use is picked for a new job
    const created = await call(null, "/api/jobs", { body: { name: "via key", cron: "0 12 * * *", url: "https://example.com" }, headers: bearer });
    expect(created.body.job.project_id).toBe(ops);
    expect((await call(null, "/api/jobs", { headers: { ...bearer, "x-project-id": defaultProject } })).status).toBe(404);
    // the key works in its own workspace only
    expect((await call(null, "/api/workspaces", { headers: bearer })).body.workspaces.map((row: { id: string }) => row.id)).toEqual([scope["x-workspace-id"]]);

    // and stops working once its creator leaves the workspace
    const adminKey = await call(admin, "/api/keys", { body: { name: "admin" }, headers: scope });
    const members = (await call(owner, "/api/members", { headers: scope })).body.members as { id: string; user_id: string }[];
    await call(owner, `/api/members/${members.find((row) => row.user_id === admin.userId)!.id}`, { method: "DELETE", headers: scope });
    expect((await call(null, "/api/jobs", { headers: { authorization: `Bearer ${adminKey.body.token}` } })).status).toBe(401);
  });
});

describe("invitations", () => {
  it("can be accepted only by the invited address, once", async () => {
    const created = await call(owner, "/api/workspaces", { body: { name: "Team" } });
    const scope = { "x-workspace-id": created.body.workspace.id };
    const invite = (await call(owner, "/api/invitations", { body: { email: member.email.toUpperCase() }, headers: scope })).body.invitation;

    const seen = await call(outsider, `/api/invite/${invite.id}`);
    expect(seen.body.invitation).toMatchObject({ workspace: { name: "Team" }, role: "member", state: "wrong_account" });
    expect((await call(outsider, `/api/invite/${invite.id}/accept`, { body: {} })).status).toBe(403);
    expect((await call(null, `/api/invite/${invite.id}`)).status).toBe(401);

    expect((await call(member, `/api/invite/${invite.id}/accept`, { body: {} })).status).toBe(200);
    expect((await call(member, "/api/workspaces")).body.current).toBe(created.body.workspace.id);
    expect((await call(member, `/api/invite/${invite.id}/accept`, { body: {} })).status).toBe(410);
    expect((await call(owner, "/api/invitations", { body: { email: member.email }, headers: scope })).status).toBe(409);
  });

  it("expire and can be withdrawn", async () => {
    const created = await call(owner, "/api/workspaces", { body: { name: "Team" } });
    const scope = { "x-workspace-id": created.body.workspace.id };
    const first = (await call(owner, "/api/invitations", { body: { email: member.email }, headers: scope })).body.invitation;
    await env.DB.prepare("UPDATE invitation SET expiresAt = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), first.id).run();
    expect((await call(member, `/api/invite/${first.id}/accept`, { body: {} })).status).toBe(410);

    const second = (await call(owner, "/api/invitations", { body: { email: member.email }, headers: scope })).body.invitation;
    expect((await call(owner, "/api/invitations", { headers: scope })).body.invitations.map((row: { id: string }) => row.id)).toEqual([second.id]);
    expect((await call(owner, `/api/invitations/${second.id}`, { method: "DELETE", headers: scope })).status).toBe(204);
    expect((await call(member, `/api/invite/${second.id}/accept`, { body: {} })).status).toBe(410);
  });
});
