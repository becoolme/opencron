import type { NotifyEvent, BuiltRequest } from "./types";
import { buildText } from "./message";
import { hmacSha256Base64 } from "./hmac";

export async function larkAdapter(
  event: NotifyEvent,
  cfg: any,
): Promise<BuiltRequest> {
  const text = buildText(event);
  const payload: Record<string, unknown> = { msg_type: "text", content: { text } };

  if (cfg.sign_secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Lark spec: key = `${timestamp}\n${secret}`, data = "" (empty)
    const sign = await hmacSha256Base64(`${timestamp}\n${cfg.sign_secret}`, "");
    payload.timestamp = timestamp;
    payload.sign = sign;
  }

  return {
    url: cfg.url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  };
}
