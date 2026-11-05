import type { NotifyEvent, BuiltRequest } from "./types";
import { buildText } from "./message";

export function discordAdapter(
  event: NotifyEvent,
  cfg: any,
): BuiltRequest {
  const text = buildText(event);
  return {
    url: cfg.url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    },
  };
}
