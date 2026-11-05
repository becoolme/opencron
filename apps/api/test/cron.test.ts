import { describe, it, expect } from "vitest";
import { validateCron, nextRunAt } from "../src/cron";

describe("validateCron", () => {
  it("accepts a valid expression", () => {
    expect(validateCron("0 12 * * *")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(validateCron("not a cron")).toBe(false);
  });
  it("rejects 6-field non-standard", () => {
    // cron-parser allows 6-field (seconds). We standardize on 5 fields.
    expect(validateCron("0 0 12 * * *")).toBe(false);
  });
});

describe("nextRunAt", () => {
  it("returns the next unix-seconds timestamp in UTC", () => {
    // 2026-04-18 00:00:00 UTC = 1776470400
    const from = 1776470400;
    const next = nextRunAt("0 12 * * *", from);
    // next run should be 2026-04-18 12:00:00 UTC = 1776513600
    expect(next).toBe(1776513600);
  });
  it("skips to next day when past today's time", () => {
    // 2026-04-18 13:00:00 UTC = 1776517200
    const from = 1776517200;
    const next = nextRunAt("0 12 * * *", from);
    // next run = 2026-04-19 12:00:00 UTC = 1776600000
    expect(next).toBe(1776600000);
  });
});
