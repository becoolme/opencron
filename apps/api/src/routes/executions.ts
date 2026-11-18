import { getDatabase } from "../database";
import { Hono } from "hono";
import type { AppHonoEnv, ExecutionRow } from "../types";
import { projectCondition } from "../workspace";

export const executionsRouter = new Hono<AppHonoEnv>();

executionsRouter.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);
  const before = Number(c.req.query("before") ?? "0") || 0;
  const projects = projectCondition(c, "j.project_id");
  const params: (string | number)[] = [c.get("workspaceId"), ...projects.params];
  if (before > 0) params.push(before);
  params.push(limit);
  const { results } = await getDatabase(c.env).prepare(
    `SELECT e.* FROM executions e
     INNER JOIN jobs j ON j.id = e.job_id
     WHERE j.organization_id = ? AND ${projects.sql}${before > 0 ? " AND e.started_at < ?" : ""}
     ORDER BY e.started_at DESC LIMIT ?`,
  ).bind(...params).all<ExecutionRow>();
  return c.json({ executions: results });
});
