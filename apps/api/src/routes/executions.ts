import { getDatabase } from "../database";
import { Hono } from "hono";
import type { AppHonoEnv, ExecutionRow } from "../types";

export const executionsRouter = new Hono<AppHonoEnv>();

executionsRouter.get("/", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);
  const before = Number(c.req.query("before") ?? "0") || 0;
  const stmt = before > 0
    ? getDatabase(c.env).prepare(
      `SELECT e.* FROM executions e
       INNER JOIN jobs j ON j.id = e.job_id
       WHERE j.owner_user_id = ? AND e.started_at < ?
       ORDER BY e.started_at DESC LIMIT ?`,
    ).bind(userId, before, limit)
    : getDatabase(c.env).prepare(
      `SELECT e.* FROM executions e
       INNER JOIN jobs j ON j.id = e.job_id
       WHERE j.owner_user_id = ?
       ORDER BY e.started_at DESC LIMIT ?`,
    ).bind(userId, limit);
  const { results } = await stmt.all<ExecutionRow>();
  return c.json({ executions: results });
});
