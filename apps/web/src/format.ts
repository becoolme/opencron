import parser from "cron-parser";
import { lang, t } from "./i18n";

export const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function locale(): string {
  return lang.value === "zh" ? "zh-CN" : "en-GB";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "11-05 03:00" in the viewer's time zone. */
export function shortDateTime(unixSec: number | null | undefined, withSeconds = false): string {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

export function clock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Thu 11-05" or "今天". */
export function dayLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return t("Today", "今天");
  if (d.toDateString() === tomorrow.toDateString()) return t("Tomorrow", "明天");
  const weekday = d.toLocaleDateString(locale(), { weekday: "short" });
  return `${weekday} ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "in 4 min", "3 days ago". */
export function relative(unixSec: number | null | undefined, nowMs = Date.now()): string {
  if (!unixSec) return "—";
  const diff = unixSec - Math.floor(nowMs / 1000);
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  if (abs < 60) return fmt.format(Math.round(diff), "second");
  if (abs < 3600) return fmt.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return fmt.format(Math.round(diff / 3600), "hour");
  return fmt.format(Math.round(diff / 86400), "day");
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Same rule as the API: five fields, parsed as UTC. */
export function validCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.split(/\s+/).length !== 5) return false;
  try {
    parser.parseExpression(trimmed, { utc: true });
    return true;
  } catch {
    return false;
  }
}

export function nextRuns(expr: string, count: number, fromMs = Date.now()): number[] {
  if (!validCron(expr)) return [];
  const it = parser.parseExpression(expr.trim(), { utc: true, currentDate: new Date(fromMs) });
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(Math.floor(it.next().getTime() / 1000));
  return out;
}

const isNum = (s: string) => /^\d+$/.test(s);

function utcTime(hour: string, minute: string): string {
  return `${pad(Number(hour))}:${pad(Number(minute))} UTC`;
}

function weekdayName(n: number): string {
  const ref = new Date(Date.UTC(2024, 0, 7 + (n % 7))); // 2024-01-07 is a Sunday
  return ref.toLocaleDateString(locale(), { weekday: "long", timeZone: "UTC" });
}

/** Plain-words reading of common cron shapes; falls back to null for anything else. */
export function describeCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, h, dom, mon, dow] = fields;
  const everyDay = dom === "*" && mon === "*" && dow === "*";

  if (fields.every((f) => f === "*")) return t("Every minute", "每分钟");
  const step = /^\*\/(\d+)$/;
  if (step.test(mi) && h === "*" && everyDay) {
    const n = mi.match(step)![1];
    return t(`Every ${n} minutes`, `每 ${n} 分钟`);
  }
  if (isNum(mi) && h === "*" && everyDay) {
    return mi === "0" ? t("Every hour, on the hour", "每小时整点") : t(`Every hour at :${pad(Number(mi))}`, `每小时第 ${Number(mi)} 分`);
  }
  if (isNum(mi) && step.test(h) && everyDay) {
    const n = h.match(step)![1];
    return t(`Every ${n} hours at :${pad(Number(mi))}`, `每 ${n} 小时，第 ${Number(mi)} 分`);
  }
  if (!isNum(mi) || !isNum(h)) return null;
  const at = utcTime(h, mi);
  if (everyDay) return t(`Every day at ${at}`, `每天 ${at}`);
  if (dom === "*" && mon === "*" && dow === "1-5") return t(`Weekdays at ${at}`, `工作日 ${at}`);
  if (dom === "*" && mon === "*" && isNum(dow)) {
    return t(`Every ${weekdayName(Number(dow))} at ${at}`, `每${weekdayName(Number(dow))} ${at}`);
  }
  if (isNum(dom) && mon === "*" && dow === "*") return t(`Day ${dom} of every month at ${at}`, `每月 ${dom} 日 ${at}`);
  return null;
}
