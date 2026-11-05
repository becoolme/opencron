import { getDatabase } from "./database";
import type { Env, JobRow } from "./types";
import { runJob } from "./runner";
import { nextRunAt } from "./cron";
import { maybeNotify } from "./notifier";
import type { LoaderExecutionContext } from "./script-runner";

/**
 * Jobs this process is running right now. A slow run can outlast the minute between ticks; without this the next tick
 * would pick the same job again, because next_run_at only moves once the run is recorded.
 */
const inFlight = new Set<number>();

export async function dispatchDueJobs(env: Env, ctx?: LoaderExecutionContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await getDatabase(env).prepare(
    "SELECT * FROM jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
  ).bind(now).all<JobRow>();

  await Promise.all(results.filter((job) => !inFlight.has(job.id)).map(async (job) => {
    inFlight.add(job.id);
    try {
      await runAndRecord(env, job, now, ctx);
    } finally {
      inFlight.delete(job.id);
    }
  }));
}

async function runAndRecord(env: Env, job: JobRow, now: number, ctx?: LoaderExecutionContext): Promise<void> {
  const result = await runJob(env, job, ctx);
  await maybeNotify(env, job, result);
  const newNext = nextRunAt(job.cron, now);
  await getDatabase(env).prepare(
    `UPDATE jobs
        SET last_run_at = ?, last_status = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(result.started_at, result.ok ? "success" : "failed", newNext, now, job.id).run();
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
