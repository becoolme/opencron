import { afterEach, describe, expect, it } from "vitest";
import { describeCron, duration, nextRuns, relative, shortDateTime, validCron } from "./format";
import { lang } from "./i18n";

afterEach(() => {
  lang.value = "en";
});

describe("validCron", () => {
  it("accepts five-field expressions", () => {
    for (const expr of ["* * * * *", "*/5 * * * *", "30 9 * * 1-5", "0 8 1 * *", " 15 2 * * 0 "]) {
      expect(validCron(expr)).toBe(true);
    }
  });

  it("rejects other field counts and bad values", () => {
    for (const expr of ["", "* * * *", "0 * * * * *", "61 * * * *", "* 24 * * *", "nope * * * *"]) {
      expect(validCron(expr)).toBe(false);
    }
  });
});

describe("nextRuns", () => {
  const from = Date.UTC(2026, 10, 5, 10, 7, 30); // Thu 2026-11-05 10:07:30 UTC

  it("lists the next times in UTC", () => {
    const runs = nextRuns("*/5 * * * *", 3, from).map((s) => new Date(s * 1000).toISOString());
    expect(runs).toEqual(["2026-11-05T10:10:00.000Z", "2026-11-05T10:15:00.000Z", "2026-11-05T10:20:00.000Z"]);
  });

  it("skips weekends for a weekday schedule", () => {
    const runs = nextRuns("30 9 * * 1-5", 2, from).map((s) => new Date(s * 1000).toISOString());
    expect(runs).toEqual(["2026-11-06T09:30:00.000Z", "2026-11-09T09:30:00.000Z"]);
  });

  it("returns nothing for an invalid expression", () => {
    expect(nextRuns("* * *", 5, from)).toEqual([]);
  });
});

describe("describeCron", () => {
  it.each([
    ["* * * * *", "Every minute"],
    ["*/5 * * * *", "Every 5 minutes"],
    ["0 * * * *", "Every hour, on the hour"],
    ["7 * * * *", "Every hour at :07"],
    ["0 */6 * * *", "Every 6 hours at :00"],
    ["0 3 * * *", "Every day at 03:00 UTC"],
    ["30 9 * * 1-5", "Weekdays at 09:30 UTC"],
    ["15 2 * * 0", "Every Sunday at 02:15 UTC"],
    ["0 8 1 * *", "Day 1 of every month at 08:00 UTC"],
  ])("reads %s", (expr, text) => {
    expect(describeCron(expr)).toBe(text);
  });

  it("reads in other languages", () => {
    lang.value = "zh-CN";
    expect(describeCron("0 3 * * *")).toBe("每天 03:00 UTC");
    expect(describeCron("15 2 * * 0")).toBe("每星期日 02:15 UTC");
    lang.value = "ja";
    expect(describeCron("0 3 * * *")).toBe("毎日 03:00 UTC");
    lang.value = "ko";
    expect(describeCron("0 3 * * *")).toBe("매일 03:00 UTC");
    lang.value = "en";
  });

  it("gives up on shapes it doesn't know", () => {
    expect(describeCron("0 0 1 1 *")).toBeNull();
    expect(describeCron("1,2 * * * *")).toBeNull();
    expect(describeCron("* *")).toBeNull();
  });
});

describe("duration", () => {
  it.each([
    [null, "—"],
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [12_345, "12.3s"],
    [59_999, "1m 0s"],
    [60_000, "1m 0s"],
    [119_600, "2m 0s"],
    [125_000, "2m 5s"],
  ])("formats %s", (ms, text) => {
    expect(duration(ms)).toBe(text);
  });
});

describe("relative", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const sec = now / 1000;

  it("reads past and future times", () => {
    expect(relative(sec + 4 * 60, now)).toBe("in 4 min");
    expect(relative(sec - 3 * 86400, now)).toBe("3 days ago");
  });

  it("shows a dash without a time", () => {
    expect(relative(null, now)).toBe("—");
  });
});

describe("shortDateTime", () => {
  it("formats in the local zone (UTC in tests)", () => {
    expect(shortDateTime(Date.UTC(2026, 10, 5, 3, 4, 5) / 1000)).toBe("11-05 03:04");
    expect(shortDateTime(Date.UTC(2026, 10, 5, 3, 4, 5) / 1000, true)).toBe("11-05 03:04:05");
    expect(shortDateTime(null)).toBe("—");
  });
});
