import { guardedFetch } from "@openuptime/kit/netguard";
import { getDatabase } from "./database";
import type { Env, JobRow, NotifyTarget } from "./types";
import type { RunResult } from "./runner";
import { getAdapter, type NotifyType } from "./notifiers";
import { buildEvent } from "./notifiers/message";
import type { NotifyEvent } from "./notifiers/types";

const WEBHOOK_TIMEOUT_MS = 10_000;
const DEDUPE_WINDOW_SEC = 60;

export async function maybeNotify(env: Env, job: JobRow, result: RunResult): Promise<void> {
  if (result.ok) return;
  if (!job.notify_targets) return;

  const now = Math.floor(Date.now() / 1000);
  if (job.last_notified_at !== null && now - job.last_notified_at < DEDUPE_WINDOW_SEC) return;

  let targets: NotifyTarget[];
  try {
    targets = JSON.parse(job.notify_targets) as NotifyTarget[];
  } catch {
    console.error(`[notify] job ${job.id}: invalid notify_targets JSON`);
    return;
  }
  if (!Array.isArray(targets) || targets.length === 0) return;

  const event = buildEvent(job, result);
  await Promise.allSettled(targets.map((t) => sendOne(t, event)));

  await getDatabase(env).prepare("UPDATE jobs SET last_notified_at = ? WHERE id = ?")
    .bind(now, job.id).run();
}

async function sendOne(target: NotifyTarget, event: NotifyEvent): Promise<void> {
  try {
    const adapter = getAdapter(target.type as NotifyType);
    const { url, init } = await adapter(event, target);
    const { res } = await guardedFetch(url, { ...init, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) }, { follow: false });
    await res.body?.cancel();
    if (!res.ok) console.error(`[notify] ${target.type} → HTTP ${res.status}`);
  } catch (e) {
    console.error(`[notify] ${target.type} failed:`, e);
  }
}
