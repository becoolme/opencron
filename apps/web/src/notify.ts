import { t } from "./i18n";
import type { NotifyDraft, NotifyTarget, NotifyType } from "./types";

export const NOTIFY_TYPES: NotifyType[] = ["slack", "discord", "lark", "dingtalk", "telegram", "http"];

export function notifyName(type: NotifyType): string {
  switch (type) {
    case "http": return "Webhook";
    case "lark": return t("Lark", "飞书");
    case "dingtalk": return t("DingTalk", "钉钉");
    case "telegram": return "Telegram";
    case "slack": return "Slack";
    case "discord": return "Discord";
  }
}

export function emptyNotifyDraft(type: NotifyType = "slack"): NotifyDraft {
  return { type, url: "", bot_token: "", chat_id: "", sign_secret: "", headers_text: "" };
}

export function urlPlaceholder(type: NotifyType): string {
  switch (type) {
    case "lark": return "https://open.feishu.cn/open-apis/bot/v2/hook/…";
    case "dingtalk": return "https://oapi.dingtalk.com/robot/send?access_token=…";
    case "slack": return "https://hooks.slack.com/services/…";
    case "discord": return "https://discord.com/api/webhooks/…";
    default: return "https://example.com/hooks/opencron";
  }
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "•••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Where a target sends to, without its secrets. */
export function targetSummary(target: NotifyTarget): string {
  if (target.type === "telegram") return `${maskSecret(target.bot_token)} → ${target.chat_id}`;
  try {
    const url = new URL(target.url);
    return `${url.host}${url.pathname.length > 1 ? "/…" : ""}`;
  } catch {
    return target.url;
  }
}

export type DraftResult = { target: NotifyTarget; error?: undefined } | { target?: undefined; error: string };

/** Turns a form draft into a target, with the same rules the API applies. */
export function draftToTarget(draft: NotifyDraft): DraftResult {
  if (draft.type === "telegram") {
    const bot_token = draft.bot_token.trim();
    const chat_id = draft.chat_id.trim();
    if (!bot_token || !chat_id) return { error: t("Enter both the bot token and the chat ID.", "请填写 bot token 和 chat ID。") };
    return { target: { type: "telegram", bot_token, chat_id } };
  }

  const url = draft.url.trim();
  if (!url) return { error: t("Enter the webhook URL.", "请填写 Webhook 地址。") };
  const scheme = draft.type === "http" ? /^https?:\/\/\S+$/i : /^https:\/\/\S+$/i;
  if (!scheme.test(url)) {
    return {
      error: draft.type === "http"
        ? t("The URL must start with http:// or https://.", "地址需以 http:// 或 https:// 开头。")
        : t("The URL must start with https://.", "地址需以 https:// 开头。"),
    };
  }

  switch (draft.type) {
    case "http": {
      if (!draft.headers_text.trim()) return { target: { type: "http", url } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.headers_text);
      } catch {
        return { error: t("Headers must be valid JSON.", "请求头需为合法 JSON。") };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: t("Headers must be a JSON object.", "请求头需为 JSON 对象。") };
      }
      if (!Object.values(parsed).every((value) => typeof value === "string")) {
        return { error: t("Header values must be strings.", "请求头的值需为字符串。") };
      }
      return { target: { type: "http", url, headers: parsed as Record<string, string> } };
    }
    case "lark":
    case "dingtalk": {
      const sign_secret = draft.sign_secret.trim();
      return { target: { type: draft.type, url, ...(sign_secret ? { sign_secret } : {}) } };
    }
    default:
      return { target: { type: draft.type, url } };
  }
}
