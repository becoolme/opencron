import { httpAdapter } from "./http";
import { larkAdapter } from "./lark";
import { telegramAdapter } from "./telegram";
import { dingtalkAdapter } from "./dingtalk";
import { slackAdapter } from "./slack";
import { discordAdapter } from "./discord";
import type { NotifyAdapter } from "./types";

export type NotifyType = "http" | "lark" | "telegram" | "dingtalk" | "slack" | "discord";

export function getAdapter(type: NotifyType): NotifyAdapter {
  switch (type) {
    case "http":     return httpAdapter as NotifyAdapter;
    case "lark":     return larkAdapter as NotifyAdapter;
    case "telegram": return telegramAdapter as NotifyAdapter;
    case "dingtalk": return dingtalkAdapter as NotifyAdapter;
    case "slack":    return slackAdapter as NotifyAdapter;
    case "discord":  return discordAdapter as NotifyAdapter;
    default: throw new Error(`unknown notify type: ${String(type)}`);
  }
}

export type { NotifyEvent, NotifyAdapter, BuiltRequest } from "./types";
