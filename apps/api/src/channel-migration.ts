import { getDatabase } from "./database";
import { channelTypeLabel, isChannelType, parseChannelConfig, sealConfig } from "./channels";
import type { Env, NotifyTarget } from "./types";

/**
 * Moves the alert targets jobs kept inline (jobs.notify_targets, before alert channels existed) into channels. The
 * config has to be encrypted, which SQL cannot do, so this runs in code at the start of each scheduler tick until no
 * job has inline targets left.
 *
 * Identical targets in one workspace become one channel, whose id is derived from the workspace and the target, so a
 * tick that stops halfway or two ticks running at once end with the same channels. A job's column is cleared only once
 * its links exist. New channels belong to the whole workspace and are not defaults, so new jobs are not affected.
 */

const BATCH = 50;
let finished = false;

/** For tests: run the move again even though this isolate already saw it finish. */
export function resetChannelMigration(): void {
  finished = false;
}

export async function migrateInlineTargets(env: Env): Promise<void> {
  if (finished) return;
  const db = getDatabase(env);
  for (;;) {
    const { results } = await db.prepare(
      // a job from before accounts existed has no workspace until its owner signs up; its targets wait until then
      `SELECT id, organization_id, notify_targets FROM jobs
        WHERE notify_targets IS NOT NULL AND organization_id IS NOT NULL ORDER BY id LIMIT ${BATCH}`,
    ).all<{ id: number; organization_id: string; notify_targets: string }>();
    if (results.length === 0) break;
    for (const job of results) await migrateJob(env, job);
    if (results.length < BATCH) break;
  }
  finished = true;
}

async function migrateJob(env: Env, job: { id: number; organization_id: string; notify_targets: string }): Promise<void> {
  const db = getDatabase(env);
  const clear = db.prepare("UPDATE jobs SET notify_targets = NULL WHERE id = ?").bind(job.id);
  let targets: unknown;
  try { targets = JSON.parse(job.notify_targets); } catch { targets = null; }
  if (!Array.isArray(targets)) {
    await clear.run();
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const statements = [];
  const linked = new Set<string>();
  for (const raw of targets) {
    const type = (raw as { type?: unknown } | null)?.type;
    if (!isChannelType(type)) continue;
    const target = parseChannelConfig(type, raw);
    if ("error" in target) {
      console.error(`[channels] job ${job.id}: skipping an alert target that is not valid: ${target.error}`);
      continue;
    }
    const id = await channelId(job.organization_id, target);
    if (linked.has(id)) continue;
    linked.add(id);
    const name = `${channelTypeLabel(type)} ${id.slice(-4)}`;
    statements.push(
      db.prepare(
        `INSERT INTO alert_channels (id, organization_id, project_id, type, name, config, enabled, auto_enable, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, 1, 0, ?, ?) ON CONFLICT (id) DO NOTHING`,
      ).bind(id, job.organization_id, type, name, await sealConfig(env, id, target), now, now),
      db.prepare("INSERT INTO job_channels (job_id, channel_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(job.id, id),
    );
  }
  await db.batch([...statements, clear]);
}

/** Keys in a fixed order, so the same target always gives the same id. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

async function channelId(workspaceId: string, target: NotifyTarget): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${workspaceId}\0${JSON.stringify(canonical(target))}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ch_${hex.slice(0, 32)}`;
}
