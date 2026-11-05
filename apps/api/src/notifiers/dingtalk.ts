import type { NotifyEvent, BuiltRequest } from "./types";
import { buildText } from "./message";
import { hmacSha256Base64 } from "./hmac";

export async function dingtalkAdapter(
  event: NotifyEvent,
  cfg: any,
): Promise<BuiltRequest> {
  const text = buildText(event);
  let url = cfg.url;

  if (cfg.sign_secret) {
    const timestamp = Date.now().toString();
    // DingTalk spec: key = secret, data = `${timestamp}\n${secret}`
    const sign = await hmacSha256Base64(cfg.sign_secret, `${timestamp}\n${cfg.sign_secret}`);
    const joiner = url.includes("?") ? "&" : "?";
    url = `${url}${joiner}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  return {
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    },
  };
}
