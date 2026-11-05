import type { JobRow } from "../types";
import type { RunResult } from "../runner";
import type { NotifyEvent } from "./types";

export function buildEvent(job: JobRow, result: RunResult): NotifyEvent {
  return {
    job_id: job.id,
    job_name: job.name,
    error: result.error,
    status_code: result.status_code,
    started_at: result.started_at,
    duration_ms: result.duration_ms,
  };
}

function iso(unixSec: number): string {
  // Always UTC, no fractional seconds. e.g. 2026-04-18T04:29:32Z
  return new Date(unixSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildText(event: NotifyEvent): string {
  return [
    `[OpenCron] job "${event.job_name}" FAILED`,
    `error: ${event.error ?? "(none)"}`,
    `status: ${event.status_code ?? "n/a"}`,
    `duration: ${event.duration_ms} ms`,
    `time: ${iso(event.started_at)}`,
  ].join("\n");
}
