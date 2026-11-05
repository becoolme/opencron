import type { NotifyEvent, BuiltRequest } from "./types";

function iso(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function httpAdapter(
  event: NotifyEvent,
  cfg: { url: string; headers?: Record<string, string>; type?: string },
): BuiltRequest {
  const payload = { ...event, time: iso(event.started_at) };
  const headers: Record<string, string> = { ...(cfg.headers ?? {}), "content-type": "application/json" };
  return {
    url: cfg.url,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  };
}
