import type { Context, MiddlewareHandler } from "hono";
import { getDatabase, type Database } from "./database";
import type { AppHonoEnv, Env, WorkspaceRole } from "./types";

/**
 * Workspaces and projects. A workspace (stored as a Better Auth `organization`) holds the jobs, secrets and API keys
 * its members share; projects group the jobs inside it. Every request under /api, once signed in, runs in exactly one
 * workspace, and membership is checked again on each request because a session or key can outlive it.
 */

export const DEFAULT_PROJECT_NAME = "Default";
export const MAX_WORKSPACE_NAME_LENGTH = 60;
export const MAX_PROJECT_NAME_LENGTH = 60;
export const MAX_PROJECTS_PER_WORKSPACE = 50;
export const MAX_WORKSPACES_PER_USER = 20;
export const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];

export function isRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isManagerRole(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

const nowIso = () => new Date().toISOString();
const nowSeconds = () => Math.floor(Date.now() / 1000);

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The statements that create a workspace with its owner and a Default project, for one batch. */
function workspaceStatements(db: Database, ids: { workspace: string; member: string; project: string }, name: string, ownerId: string) {
  return [
    db.prepare(`INSERT INTO organization (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(ids.workspace, name, ids.workspace.replace(/_/g, "-").toLowerCase(), nowIso()),
    db.prepare(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)`)
      .bind(ids.member, ids.workspace, ownerId, nowIso()),
    db.prepare("INSERT INTO projects (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(ids.project, ids.workspace, DEFAULT_PROJECT_NAME, nowSeconds()),
  ];
}

/** Creates a workspace owned by `ownerId` with a Default project and returns its id. */
export async function createWorkspace(env: Env, ownerId: string, name: string): Promise<string> {
  const db = getDatabase(env);
  const ids = { workspace: randomId("ws"), member: randomId("mb"), project: randomId("pj") };
  await db.batch(workspaceStatements(db, ids, name, ownerId));
  return ids.workspace;
}

/**
 * The personal workspace every account gets on sign-up, with the same ids the upgrade migration gives existing
 * accounts. Ownerless jobs from before accounts existed move into it, as they did before workspaces.
 */
export async function createPersonalWorkspace(env: Env, user: { id: string; name: string }): Promise<string> {
  const db = getDatabase(env);
  const ids = { workspace: `ws_${user.id}`, member: `mb_${user.id}`, project: `pj_${user.id}` };
  const exists = await db.prepare("SELECT id FROM organization WHERE id = ?").bind(ids.workspace).first<{ id: string }>();
  if (!exists) await db.batch(workspaceStatements(db, ids, user.name || "Personal", user.id));
  await db.prepare(
    "UPDATE jobs SET owner_user_id = ?, organization_id = ?, project_id = ? WHERE owner_user_id IS NULL AND organization_id IS NULL",
  ).bind(user.id, ids.workspace, ids.project).run();
  return ids.workspace;
}

export interface MembershipRow { id: string; name: string; role: WorkspaceRole }

export async function listMemberships(env: Env, userId: string): Promise<MembershipRow[]> {
  const { results } = await getDatabase(env).prepare(
    `SELECT o.id, o.name, m.role FROM member m JOIN organization o ON o.id = m."organizationId"
      WHERE m."userId" = ? ORDER BY o."createdAt", o.id`,
  ).bind(userId).all<MembershipRow>();
  return results;
}

export async function membershipRole(env: Env, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const row = await getDatabase(env).prepare(`SELECT role FROM member WHERE "organizationId" = ? AND "userId" = ?`)
    .bind(workspaceId, userId).first<{ role: string }>();
  return row && isRole(row.role) ? row.role : null;
}

export interface ProjectRow { id: string; name: string; created_at: number }

export async function listProjects(env: Env, workspaceId: string): Promise<ProjectRow[]> {
  const { results } = await getDatabase(env).prepare(
    "SELECT id, name, created_at FROM projects WHERE organization_id = ? ORDER BY created_at, name",
  ).bind(workspaceId).all<ProjectRow>();
  return results.map((row) => ({ ...row, created_at: Number(row.created_at) }));
}

async function activeWorkspaceOfSession(env: Env, sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const row = await getDatabase(env).prepare(`SELECT "activeOrganizationId" AS id FROM session WHERE id = ?`)
    .bind(sessionId).first<{ id: string | null }>();
  return row?.id ?? null;
}

export async function setActiveWorkspace(env: Env, sessionId: string, workspaceId: string): Promise<void> {
  await getDatabase(env).prepare(`UPDATE session SET "activeOrganizationId" = ? WHERE id = ?`).bind(workspaceId, sessionId).run();
}

/**
 * Picks the workspace and project of a request.
 *
 * - An API key works in its own workspace only, and only in its projects when it is limited to some.
 * - A session uses the `x-workspace-id` header, else the workspace it last switched to, else the first it belongs to.
 *   An account that belongs to none (it left or was removed from all of them) gets a new personal workspace.
 * - `x-project-id` picks a project; missing or `all` is the workspace-wide view.
 */
export const workspaceMiddleware: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  const env = c.env;
  const userId = c.get("userId");
  let workspaceId: string | null;
  let role: WorkspaceRole | null;

  if (c.get("authMethod") === "api_key") {
    workspaceId = c.get("apiKeyWorkspaceId") ?? null;
    role = workspaceId ? await membershipRole(env, workspaceId, userId) : null;
    if (!workspaceId || !role) return c.json({ error: "The account behind this API key is no longer a member of its workspace" }, 403);
  } else {
    const requested = c.req.header("x-workspace-id")?.trim() || null;
    if (requested) {
      workspaceId = requested;
      role = await membershipRole(env, requested, userId);
      if (!role) return c.json({ error: "Workspace not found" }, 404);
    } else {
      workspaceId = await activeWorkspaceOfSession(env, c.get("sessionId"));
      role = workspaceId ? await membershipRole(env, workspaceId, userId) : null;
      if (!role) {
        const memberships = await listMemberships(env, userId);
        const first = memberships[0] ?? null;
        workspaceId = first?.id ?? await createPersonalWorkspace(env, { id: userId, name: c.get("userName") });
        role = first?.role ?? "owner";
        const sessionId = c.get("sessionId");
        if (sessionId) await setActiveWorkspace(env, sessionId, workspaceId);
      }
    }
  }

  const keyProjects = c.get("authMethod") === "api_key" ? c.get("apiKeyProjectIds") ?? null : null;
  const requestedProject = c.req.header("x-project-id")?.trim() || null;
  let projectId: string | null = null;
  if (requestedProject && requestedProject !== "all") {
    const project = await getDatabase(env).prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?")
      .bind(requestedProject, workspaceId).first<{ id: string }>();
    if (!project || (keyProjects && !keyProjects.includes(project.id))) return c.json({ error: "Project not found" }, 404);
    projectId = project.id;
  }

  c.set("workspaceId", workspaceId!);
  c.set("workspaceRole", role!);
  c.set("projectId", projectId);
  c.set("visibleProjectIds", projectId ? [projectId] : keyProjects);
  await next();
};

/** Refuses the request unless the caller is an owner or admin of the workspace. */
export const requireManager: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  if (!isManagerRole(c.get("workspaceRole"))) return c.json({ error: "Only workspace owners and admins can do this" }, 403);
  await next();
};

/** A SQL condition limiting `column` to the projects this request may see, with its parameters. */
export function projectCondition(c: Context<AppHonoEnv, string>, column: string): { sql: string; params: string[] } {
  const visible = c.get("visibleProjectIds");
  if (!visible) return { sql: "1 = 1", params: [] };
  if (visible.length === 0) return { sql: "1 = 0", params: [] };
  return { sql: `${column} IN (${visible.map(() => "?").join(", ")})`, params: visible };
}

/** Whether this request may see a job in `projectId`. */
export function canSeeProject(c: Context<AppHonoEnv, string>, projectId: string | null): boolean {
  const visible = c.get("visibleProjectIds");
  return !visible || (projectId != null && visible.includes(projectId));
}

/**
 * The project a new job goes into: the one named in the request, else the one chosen with x-project-id, else the only
 * project the caller can use. Returns an error message when none of these settles it.
 */
export async function projectForNewJob(c: Context<AppHonoEnv, string>, requested: unknown): Promise<{ id: string } | { error: string }> {
  if (requested !== undefined && requested !== null && typeof requested !== "string") return { error: "project_id must be a string" };
  const workspaceId = c.get("workspaceId");
  if (typeof requested === "string" && requested) {
    const project = await getDatabase(c.env).prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?")
      .bind(requested, workspaceId).first<{ id: string }>();
    if (!project || !canSeeProject(c, project.id)) return { error: "project_id is not a project of this workspace" };
    return { id: project.id };
  }
  const chosen = c.get("projectId");
  if (chosen) return { id: chosen };
  const usable = (await listProjects(c.env, workspaceId)).filter((project) => canSeeProject(c, project.id));
  if (usable.length === 1) return { id: usable[0]!.id };
  return { error: "Choose a project: set project_id, or send the x-project-id header" };
}
