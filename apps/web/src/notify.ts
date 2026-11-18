import { t } from "./i18n";
import type { NotifyDraft, NotifyTarget, NotifyType } from "./types";

export const NOTIFY_TYPES: NotifyType[] = ["slack", "discord", "lark", "dingtalk", "telegram", "http"];

export function notifyName(type: NotifyType): string {
  switch (type) {
    case "http": return "Webhook";
    case "lark": return t("Lark");
    case "dingtalk": return t("DingTalk");
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

/** A form draft for a saved channel. Secrets arrive masked; sending them back unchanged keeps the saved values. */
export function configToDraft(type: NotifyType, config: Record<string, unknown> | null): NotifyDraft {
  const draft = emptyNotifyDraft(type);
  if (!config) return draft;
  const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  draft.url = text("url");
  draft.bot_token = text("bot_token");
  draft.chat_id = text("chat_id");
  draft.sign_secret = text("sign_secret");
  if (config.headers && typeof config.headers === "object") draft.headers_text = JSON.stringify(config.headers);
  return draft;
}

/**
 * The `config` to send for a draft, or the error to show. When editing, an emptied signing secret is sent as null,
 * which removes it; any other empty or masked field keeps what is saved.
 */
export function draftToConfig(draft: NotifyDraft, editing: boolean): { config: Record<string, unknown>; error?: undefined } | { config?: undefined; error: string } {
  const result = draftToTarget(draft);
  if (result.error !== undefined) return { error: result.error };
  const { type: _type, ...config } = result.target as NotifyTarget & Record<string, unknown>;
  if (editing && (draft.type === "lark" || draft.type === "dingtalk") && !draft.sign_secret.trim()) {
    return { config: { ...config, sign_secret: null } };
  }
  return { config };
}

/** Where a channel sends to, from its masked config. */
export function channelSummary(type: NotifyType, config: Record<string, unknown> | null): string {
  if (!config) return t("Settings can't be read. Enter them again.");
  if (type === "telegram") return `${String(config.bot_token ?? "")} → ${String(config.chat_id ?? "")}`;
  try {
    return new URL(String(config.url)).host;
  } catch {
    return String(config.url ?? "");
  }
}

export type DraftResult = { target: NotifyTarget; error?: undefined } | { target?: undefined; error: string };

/** Turns a form draft into a target, with the same rules the API applies. */
export function draftToTarget(draft: NotifyDraft): DraftResult {
  if (draft.type === "telegram") {
    const bot_token = draft.bot_token.trim();
    const chat_id = draft.chat_id.trim();
    if (!bot_token || !chat_id) return { error: t("Enter both the bot token and the chat ID.") };
    return { target: { type: "telegram", bot_token, chat_id } };
  }

  const url = draft.url.trim();
  if (!url) return { error: t("Enter the webhook URL.") };
  const scheme = draft.type === "http" ? /^https?:\/\/\S+$/i : /^https:\/\/\S+$/i;
  if (!scheme.test(url)) {
    return {
      error: draft.type === "http"
        ? t("The URL must start with http:// or https://.")
        : t("The URL must start with https://."),
    };
  }

  switch (draft.type) {
    case "http": {
      if (!draft.headers_text.trim()) return { target: { type: "http", url } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.headers_text);
      } catch {
        return { error: t("Headers must be valid JSON.") };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: t("Headers must be a JSON object.") };
      }
      if (!Object.values(parsed).every((value) => typeof value === "string")) {
        return { error: t("Header values must be strings.") };
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
