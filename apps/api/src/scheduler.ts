import { getDatabase } from "./database";
import type { Env, JobRow } from "./types";
import { runJob } from "./runner";
import { nextRunAt } from "./cron";
import { maybeNotify } from "./notifier";
import type { LoaderExecutionContext } from "./script-runner";

/**
 * Each tick claims a job before running it by moving next_run_at forward, guarded on the value it read. A second tick,
 * another isolate or another replica that read the same row finds it changed and skips the job, so a slow run is never
 * started twice and one due time runs once.
 */
export async function dispatchDueJobs(env: Env, ctx?: LoaderExecutionContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await getDatabase(env).prepare(
    "SELECT * FROM jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
  ).bind(now).all<JobRow>();

  await Promise.all(results.map(async (job) => {
    if (!(await claim(env, job, now))) return;
    try {
      await runAndRecord(env, job, ctx);
    } catch (error) {
      console.error(`[scheduler] job ${job.id} failed to run:`, error);
    }
  }));
}

/** Advances next_run_at when nobody else has; true when this caller owns the run. */
async function claim(env: Env, job: JobRow, now: number): Promise<boolean> {
  const claimed = await getDatabase(env).prepare(
    "UPDATE jobs SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ? RETURNING id",
  ).bind(nextRunAt(job.cron, now), job.id, job.next_run_at).first<{ id: number }>();
  return claimed !== null;
}

async function runAndRecord(env: Env, job: JobRow, ctx?: LoaderExecutionContext): Promise<void> {
  const result = await runJob(env, job, ctx);
  // Only the outcome is written: an edit saved while the job ran (cron, enabled, next run) stays as it was saved.
  await getDatabase(env).prepare(
    "UPDATE jobs SET last_run_at = ?, last_status = ? WHERE id = ?",
  ).bind(result.started_at, result.ok ? "success" : "failed", job.id).run();
  try {
    await maybeNotify(env, job, result);
  } catch (error) {
    console.error(`[scheduler] job ${job.id}: alerts failed:`, error);
  }
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
