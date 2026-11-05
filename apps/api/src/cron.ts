import parser from "cron-parser";

/** Accepts only standard 5-field cron expressions (minute, hour, dom, month, dow). */
export function validateCron(expr: string): boolean {
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  try {
    parser.parseExpression(trimmed, { utc: true });
    return true;
  } catch {
    return false;
  }
}

/** Returns the next scheduled time as a unix-seconds timestamp (UTC). */
export function nextRunAt(expr: string, fromUnixSec: number): number {
  const it = parser.parseExpression(expr, {
    utc: true,
    currentDate: new Date(fromUnixSec * 1000),
  });
  return Math.floor(it.next().getTime() / 1000);
}
