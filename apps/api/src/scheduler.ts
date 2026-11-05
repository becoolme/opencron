import { getDatabase } from "./database";
import type { Env, JobRow } from "./types";
import { runJob } from "./runner";
import { nextRunAt } from "./cron";
import { maybeNotify } from "./notifier";
import type { LoaderExecutionContext } from "./script-runner";

export async function dispatchDueJobs(env: Env, ctx?: LoaderExecutionContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await getDatabase(env).prepare(
    "SELECT * FROM jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
  ).bind(now).all<JobRow>();

  await Promise.all(results.map(async (job) => {
    const result = await runJob(env, job, ctx);
    await maybeNotify(env, job, result);
    const newNext = nextRunAt(job.cron, now);
    await getDatabase(env).prepare(
      `UPDATE jobs
          SET last_run_at = ?, last_status = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(result.started_at, result.ok ? "success" : "failed", newNext, now, job.id).run();
  }));
}

export async function cleanupOldExecutions(env: Env, nowSec: number): Promise<void> {
  const cutoff = nowSec - 7 * 86400;
  await getDatabase(env).prepare("DELETE FROM executions WHERE started_at < ?").bind(cutoff).run();
}

export async function handleScheduled(env: Env, ctx?: LoaderExecutionContext): Promise<void> {
  await dispatchDueJobs(env, ctx);
  // Probabilistic cleanup, ~1/60 per minute → about once an hour on average.
  if (Math.random() < 1 / 60) {
    await cleanupOldExecutions(env, Math.floor(Date.now() / 1000));
  }
}
