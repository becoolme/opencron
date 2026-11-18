import { Hono, type Context } from "hono";
import { getDatabase } from "../database";
import type { AppHonoEnv, WorkspaceRole } from "../types";
import {
  MAX_PROJECTS_PER_WORKSPACE, MAX_PROJECT_NAME_LENGTH, MAX_WORKSPACES_PER_USER, MAX_WORKSPACE_NAME_LENGTH,
  canSeeProject, createWorkspace, isManagerRole, listMemberships, listProjects, membershipRole, requireManager,
  setActiveWorkspace,
} from "../workspace";
import { deleteKvPrefix } from "./jobs";

/** How long an invitation link stays valid. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_INVITATIONS = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Json = Record<string, unknown>;
async function readJson(c: Context<AppHonoEnv, string>): Promise<Json | null> {
  const input = await c.req.json().catch(() => null) as unknown;
  return input && typeof input === "object" && !Array.isArray(input) ? input as Json : null;
}

function cleanName(value: unknown, max: number): string | { error: string } {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { error: "name is required" };
  if (name.length > max) return { error: `name is at most ${max} characters` };
  return name;
}

const sessionOnly = async (c: Context<AppHonoEnv, string>, next: () => Promise<void>) => {
  if (c.get("authMethod") !== "session") return c.json({ error: "Only available from the app, not with an API key" }, 403);
  await next();
};

/** Where an invitation link points: the app's invite page on this deployment. */
function invitationUrl(c: Context<AppHonoEnv, string>, id: string): string {
  const origin = c.env.APP_URL ? new URL(c.env.APP_URL).origin : new URL(c.req.url).origin;
  return `${origin}/app/invite/${id}`;
}

/* ---------------------------------------------------------------- workspaces */

export const workspacesRouter = new Hono<AppHonoEnv>();

workspacesRouter.get("/", async (c) => {
  const current = c.get("workspaceId");
  const all = await listMemberships(c.env, c.get("userId"));
  // an API key only ever works in its own workspace
  const workspaces = c.get("authMethod") === "api_key" ? all.filter((workspace) => workspace.id === current) : all;
  return c.json({ workspaces, current });
});

workspacesRouter.post("/", sessionOnly, async (c) => {
  const input = await readJson(c);
  if (!input) return c.json({ error: "Expected a JSON object" }, 400);
  const name = cleanName(input.name, MAX_WORKSPACE_NAME_LENGTH);
  if (typeof name !== "string") return c.json(name, 400);
  const userId = c.get("userId");
  const owned = (await listMemberships(c.env, userId)).filter((workspace) => workspace.role === "owner").length;
  if (owned >= MAX_WORKSPACES_PER_USER) return c.json({ error: `An account can own at most ${MAX_WORKSPACES_PER_USER} workspaces` }, 400);
  const id = await createWorkspace(c.env, userId, name);
  await setActiveWorkspace(c.env, c.get("sessionId")!, id);
  return c.json({ workspace: { id, name, role: "owner" as WorkspaceRole } }, 201);
});

workspacesRouter.post("/:id/activate", sessionOnly, async (c) => {
  const id = c.req.param("id");
  const role = await membershipRole(c.env, id, c.get("userId"));
  if (!role) return c.json({ error: "Workspace not found" }, 404);
  await setActiveWorkspace(c.env, c.get("sessionId")!, id);
  return c.json({ current: id });
});

workspacesRouter.patch("/current", requireManager, async (c) => {
  const input = await readJson(c);
  if (!input) return c.json({ error: "Expected a JSON object" }, 400);
  const name = cleanName(input.name, MAX_WORKSPACE_NAME_LENGTH);
  if (typeof name !== "string") return c.json(name, 400);
  await getDatabase(c.env).prepare("UPDATE organization SET name = ? WHERE id = ?").bind(name, c.get("workspaceId")).run();
  return c.json({ workspace: { id: c.get("workspaceId"), name, role: c.get("workspaceRole") } });
});

/** Deletes the current workspace with every job, run, secret, key and invitation in it. Owners only. */
workspacesRouter.delete("/current", sessionOnly, async (c) => {
  if (c.get("workspaceRole") !== "owner") return c.json({ error: "Only a workspace owner can delete it" }, 403);
  const workspaceId = c.get("workspaceId");
  const db = getDatabase(c.env);
  const { results: jobs } = await db.prepare("SELECT id, owner_user_id FROM jobs WHERE organization_id = ?")
    .bind(workspaceId).all<{ id: number; owner_user_id: string | null }>();
  await db.batch([
    db.prepare("DELETE FROM executions WHERE job_id IN (SELECT id FROM jobs WHERE organization_id = ?)").bind(workspaceId),
    db.prepare("DELETE FROM jobs WHERE organization_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM organization WHERE id = ?").bind(workspaceId),
  ]);
  const kv = c.env.SCRIPT_KV;
  if (kv && jobs.length) {
    const cleanup = Promise.all(jobs.map((job) => deleteKvPrefix(kv, `opencron:v1:user:${job.owner_user_id}:job:${job.id}:`)))
      .catch((error) => console.error(`[workspaces] ${workspaceId}: KV cleanup failed:`, error));
    try { (c.executionCtx as unknown as ExecutionContext).waitUntil(cleanup); } catch { await cleanup; }
  }
  return c.body(null, 204);
});

/* ---------------------------------------------------------------- projects */

export const projectsRouter = new Hono<AppHonoEnv>();

projectsRouter.get("/", async (c) => {
  const projects = (await listProjects(c.env, c.get("workspaceId"))).filter((project) => canSeeProject(c, project.id));
  return c.json({ projects });
});

projectsRouter.post("/", requireManager, async (c) => {
  const input = await readJson(c);
  if (!input) return c.json({ error: "Expected a JSON object" }, 400);
  const name = cleanName(input.name, MAX_PROJECT_NAME_LENGTH);
  if (typeof name !== "string") return c.json(name, 400);
  const workspaceId = c.get("workspaceId");
  const existing = await listProjects(c.env, workspaceId);
  if (existing.length >= MAX_PROJECTS_PER_WORKSPACE) return c.json({ error: `A workspace can have at most ${MAX_PROJECTS_PER_WORKSPACE} projects` }, 400);
  if (existing.some((project) => project.name.toLowerCase() === name.toLowerCase())) return c.json({ error: "A project with this name already exists" }, 409);
  const project = { id: `pj_${crypto.randomUUID().replace(/-/g, "")}`, name, created_at: Math.floor(Date.now() / 1000) };
  await getDatabase(c.env).prepare("INSERT INTO projects (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(project.id, workspaceId, name, project.created_at).run();
  return c.json({ project }, 201);
});

projectsRouter.patch("/:id", requireManager, async (c) => {
  const input = await readJson(c);
  if (!input) return c.json({ error: "Expected a JSON object" }, 400);
  const name = cleanName(input.name, MAX_PROJECT_NAME_LENGTH);
  if (typeof name !== "string") return c.json(name, 400);
  const projects = await listProjects(c.env, c.get("workspaceId"));
  const project = projects.find((row) => row.id === c.req.param("id"));
  if (!project) return c.json({ error: "Not found" }, 404);
  if (projects.some((row) => row.id !== project.id && row.name.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: "A project with this name already exists" }, 409);
  }
  await getDatabase(c.env).prepare("UPDATE projects SET name = ? WHERE id = ?").bind(name, project.id).run();
  return c.json({ project: { ...project, name } });
});

projectsRouter.delete("/:id", requireManager, async (c) => {
  const db = getDatabase(c.env);
  const projects = await listProjects(c.env, c.get("workspaceId"));
  const project = projects.find((row) => row.id === c.req.param("id"));
  if (!project) return c.json({ error: "Not found" }, 404);
  if (projects.length === 1) return c.json({ error: "A workspace keeps at least one project" }, 400);
  const jobs = await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?").bind(project.id).first<{ n: number }>();
  if (Number(jobs?.n ?? 0) > 0) return c.json({ error: "Move or delete the jobs in this project first" }, 400);
  await db.prepare("DELETE FROM projects WHERE id = ?").bind(project.id).run();
  return c.body(null, 204);
});

/* ---------------------------------------------------------------- members */

interface MemberRow { id: string; user_id: string; name: string; email: string; role: WorkspaceRole; created_at: string }

async function listMembers(c: Context<AppHonoEnv, string>): Promise<MemberRow[]> {
  const { results } = await getDatabase(c.env).prepare(
    `SELECT m.id, m."userId" AS user_id, u.name, u.email, m.role, m."createdAt" AS created_at
       FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ? ORDER BY m."createdAt", m.id`,
  ).bind(c.get("workspaceId")).all<MemberRow>();
  return results.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() }));
}

export const membersRouter = new Hono<AppHonoEnv>();

membersRouter.get("/", async (c) => c.json({ members: await listMembers(c), role: c.get("workspaceRole") }));

membersRouter.patch("/:id", sessionOnly, requireManager, async (c) => {
  const input = await readJson(c);
  const role = input?.role;
  if (role !== "owner" && role !== "admin" && role !== "member") return c.json({ error: "role must be 'owner', 'admin' or 'member'" }, 400);
  const members = await listMembers(c);
  const target = members.find((member) => member.id === c.req.param("id"));
  if (!target) return c.json({ error: "Not found" }, 404);
  const actorIsOwner = c.get("workspaceRole") === "owner";
  if ((role === "owner" || target.role === "owner") && !actorIsOwner) return c.json({ error: "Only an owner can grant or take away the owner role" }, 403);
  if (target.role === "owner" && role !== "owner" && members.filter((member) => member.role === "owner").length === 1) {
    return c.json({ error: "A workspace needs at least one owner" }, 400);
  }
  await getDatabase(c.env).prepare("UPDATE member SET role = ? WHERE id = ?").bind(role, target.id).run();
  return c.json({ member: { ...target, role } });
});

/** Removes a member, or lets a member leave. Their jobs stay in the workspace; their API keys for it are revoked. */
membersRouter.delete("/:id", sessionOnly, async (c) => {
  const members = await listMembers(c);
  const target = members.find((member) => member.id === c.req.param("id"));
  if (!target) return c.json({ error: "Not found" }, 404);
  const self = target.user_id === c.get("userId");
  const actor = c.get("workspaceRole");
  if (!self && !isManagerRole(actor)) return c.json({ error: "Only workspace owners and admins can do this" }, 403);
  if (!self && target.role === "owner" && actor !== "owner") return c.json({ error: "Only an owner can remove an owner" }, 403);
  if (target.role === "owner" && members.filter((member) => member.role === "owner").length === 1) {
    return c.json({ error: "A workspace needs at least one owner. Make someone else owner first, or delete the workspace." }, 400);
  }
  const db = getDatabase(c.env);
  await db.batch([
    db.prepare("DELETE FROM api_keys WHERE organization_id = ? AND owner_user_id = ?").bind(c.get("workspaceId"), target.user_id),
    db.prepare("DELETE FROM member WHERE id = ?").bind(target.id),
  ]);
  return c.body(null, 204);
});

/* ---------------------------------------------------------------- invitations (managed by the workspace) */

interface InvitationRow { id: string; email: string; role: WorkspaceRole; status: string; expiresAt: string; createdAt: string; inviter_name: string | null }

function invitationDto(c: Context<AppHonoEnv, string>, row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expires_at: new Date(row.expiresAt).toISOString(),
    created_at: new Date(row.createdAt).toISOString(),
    invited_by: row.inviter_name,
    url: invitationUrl(c, row.id),
  };
}

export const invitationsRouter = new Hono<AppHonoEnv>();
invitationsRouter.use("*", sessionOnly, requireManager);

invitationsRouter.get("/", async (c) => {
  const { results } = await getDatabase(c.env).prepare(
    `SELECT i.id, i.email, i.role, i.status, i."expiresAt", i."createdAt", u.name AS inviter_name
       FROM invitation i LEFT JOIN "user" u ON u.id = i."inviterId"
      WHERE i."organizationId" = ? AND i.status = 'pending' AND i."expiresAt" > ? ORDER BY i."createdAt" DESC`,
  ).bind(c.get("workspaceId"), new Date().toISOString()).all<InvitationRow>();
  return c.json({ invitations: results.map((row) => invitationDto(c, row)) });
});

/** Creates an invitation and returns its link, which the inviter sends themselves; no email goes out. */
invitationsRouter.post("/", async (c) => {
  const input = await readJson(c);
  if (!input) return c.json({ error: "Expected a JSON object" }, 400);
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) return c.json({ error: "email is not a valid address" }, 400);
  const role = input.role ?? "member";
  if (role !== "admin" && role !== "member") return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  const workspaceId = c.get("workspaceId");
  const db = getDatabase(c.env);
  const member = await db.prepare(
    `SELECT 1 AS one FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ? AND lower(u.email) = ?`,
  ).bind(workspaceId, email).first();
  if (member) return c.json({ error: "This person is already a member" }, 409);
  const pending = await db.prepare(`SELECT COUNT(*) AS n FROM invitation WHERE "organizationId" = ? AND status = 'pending'`)
    .bind(workspaceId).first<{ n: number }>();
  if (Number(pending?.n ?? 0) >= MAX_PENDING_INVITATIONS) return c.json({ error: `A workspace can have at most ${MAX_PENDING_INVITATIONS} open invitations` }, 400);

  const now = new Date();
  const row: InvitationRow = {
    // the id is the secret in the link
    id: crypto.randomUUID(),
    email,
    role,
    status: "pending",
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
    inviter_name: c.get("userName"),
  };
  await db.batch([
    // a new invitation replaces an open one for the same address
    db.prepare(`DELETE FROM invitation WHERE "organizationId" = ? AND lower(email) = ? AND status = 'pending'`).bind(workspaceId, email),
    db.prepare(
      `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(row.id, workspaceId, email, role, row.expiresAt, row.createdAt, c.get("userId")),
  ]);
  return c.json({ invitation: invitationDto(c, row) }, 201);
});

invitationsRouter.delete("/:id", async (c) => {
  const db = getDatabase(c.env);
  const existing = await db.prepare(`SELECT id FROM invitation WHERE id = ? AND "organizationId" = ? AND status = 'pending'`)
    .bind(c.req.param("id"), c.get("workspaceId")).first<{ id: string }>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.prepare("UPDATE invitation SET status = 'canceled' WHERE id = ?").bind(existing.id).run();
  return c.body(null, 204);
});

/* ---------------------------------------------------------------- invitations (seen by the invitee) */

/**
 * Mounted outside the workspace scope: the invitee is not a member yet. Reading an invitation needs a session; it can
 * be accepted only by the account whose email it was made for.
 */
export const inviteRouter = new Hono<AppHonoEnv>();
inviteRouter.use("*", sessionOnly);

interface InviteRow { id: string; email: string; role: WorkspaceRole; status: string; expiresAt: string; organizationId: string; workspace_name: string; inviter_name: string | null }

async function findInvite(c: Context<AppHonoEnv, string>): Promise<InviteRow | null> {
  return getDatabase(c.env).prepare(
    `SELECT i.id, i.email, i.role, i.status, i."expiresAt", i."organizationId", o.name AS workspace_name, u.name AS inviter_name
       FROM invitation i JOIN organization o ON o.id = i."organizationId" LEFT JOIN "user" u ON u.id = i."inviterId"
      WHERE i.id = ?`,
  ).bind(c.req.param("id")).first<InviteRow>();
}

function inviteState(c: Context<AppHonoEnv, string>, invite: InviteRow): "pending" | "expired" | "used" | "wrong_account" {
  if (invite.status !== "pending") return "used";
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return "expired";
  if (invite.email.toLowerCase() !== c.get("userEmail").toLowerCase()) return "wrong_account";
  return "pending";
}

inviteRouter.get("/:id", async (c) => {
  const invite = await findInvite(c);
  if (!invite) return c.json({ error: "This invitation does not exist" }, 404);
  return c.json({
    invitation: {
      id: invite.id,
      workspace: { id: invite.organizationId, name: invite.workspace_name },
      email: invite.email,
      role: invite.role,
      invited_by: invite.inviter_name,
      state: inviteState(c, invite),
    },
  });
});

inviteRouter.post("/:id/accept", async (c) => {
  const invite = await findInvite(c);
  if (!invite) return c.json({ error: "This invitation does not exist" }, 404);
  const state = inviteState(c, invite);
  if (state === "used") return c.json({ error: "This invitation has already been used or was withdrawn" }, 410);
  if (state === "expired") return c.json({ error: "This invitation has expired. Ask for a new one." }, 410);
  if (state === "wrong_account") return c.json({ error: `This invitation is for ${invite.email}. Sign in with that address to accept it.` }, 403);

  const userId = c.get("userId");
  const db = getDatabase(c.env);
  const already = await membershipRole(c.env, invite.organizationId, userId);
  await db.batch([
    ...(already ? [] : [db.prepare(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`mb_${crypto.randomUUID().replace(/-/g, "")}`, invite.organizationId, userId, invite.role, new Date().toISOString())]),
    db.prepare("UPDATE invitation SET status = 'accepted' WHERE id = ?").bind(invite.id),
  ]);
  await setActiveWorkspace(c.env, c.get("sessionId")!, invite.organizationId);
  return c.json({ workspace: { id: invite.organizationId, name: invite.workspace_name, role: already ?? invite.role } });
});
