import type { NotifyEvent, BuiltRequest } from "./types";
import { buildText } from "./message";

export function telegramAdapter(
  event: NotifyEvent,
  cfg: any,
): BuiltRequest {
  const text = buildText(event);
  return {
    url: `https://api.telegram.org/bot${cfg.bot_token}/sendMessage`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chat_id, text }),
    },
  };
}
