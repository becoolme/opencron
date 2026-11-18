import { guardedFetch } from "@openuptime/kit/netguard";
import { getDatabase } from "./database";
import type { Env, JobRow, NotifyTarget } from "./types";
import type { RunResult } from "./runner";
import { getAdapter, type NotifyType } from "./notifiers";
import { buildEvent } from "./notifiers/message";
import type { NotifyEvent } from "./notifiers/types";
import { targetsForJob } from "./channels";

const WEBHOOK_TIMEOUT_MS = 10_000;
const DEDUPE_WINDOW_SEC = 60;

/** Sends a failed run to the job's enabled alert channels, at most once a minute per job. */
export async function maybeNotify(env: Env, job: JobRow, result: RunResult): Promise<void> {
  if (result.ok) return;

  const now = Math.floor(Date.now() / 1000);
  if (job.last_notified_at !== null && now - Number(job.last_notified_at) < DEDUPE_WINDOW_SEC) return;

  const channels = await targetsForJob(env, job.id);
  if (channels.length === 0) return;

  const event = buildEvent(job, result);
  await Promise.allSettled(channels.map((channel) => sendOne(channel.target, event)));

  await getDatabase(env).prepare("UPDATE jobs SET last_notified_at = ? WHERE id = ?")
    .bind(now, job.id).run();
}

/** Sends one alert; resolves to an error message, or null when the destination accepted it. */
export async function sendOne(target: NotifyTarget, event: NotifyEvent): Promise<string | null> {
  try {
    const adapter = getAdapter(target.type as NotifyType);
    const { url, init } = await adapter(event, target);
    const { res } = await guardedFetch(url, { ...init, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) }, { follow: false });
    await res.body?.cancel();
    if (!res.ok) {
      console.error(`[notify] ${target.type} → HTTP ${res.status}`);
      return `The destination answered HTTP ${res.status}`;
    }
    return null;
  } catch (e) {
    console.error(`[notify] ${target.type} failed:`, e);
    return e instanceof Error ? e.message : String(e);
  }
}
