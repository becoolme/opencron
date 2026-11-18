import { describe, expect, it } from "vitest";
import { buildEvent, buildText } from "../../src/notifiers/message";
import type { JobRow } from "../../src/types";
import type { RunResult } from "../../src/runner";

const baseJob: JobRow = {
  id: 42,
  name: "hello",
  url: "https://example.test/x",
  method: "GET",
  headers: null,
  body: null,
  cron: "* * * * *",
  enabled: 1,
  timeout_ms: 30000,
  next_run_at: 0,
  last_run_at: null,
  last_status: null,
  type: "url",
  runtime: "javascript",
  script: null,
  script_version: 1,
  notify_targets: null,
  last_notified_at: null,
  owner_user_id: null,
  organization_id: null,
  project_id: null,
  created_at: 0,
  updated_at: 0,
};

describe("buildEvent", () => {
  it("maps JobRow + RunResult → NotifyEvent", () => {
    const result: RunResult = {
      started_at: 1776486572,
      duration_ms: 1234,
      status_code: 500,
      ok: false,
      error: "oops",
      response_snippet: null,
    };
    const ev = buildEvent(baseJob, result);
    expect(ev).toEqual({
      job_id: 42,
      job_name: "hello",
      error: "oops",
      status_code: 500,
      started_at: 1776486572,
      duration_ms: 1234,
    });
  });

  it("carries null error/status when absent", () => {
    const result: RunResult = {
      started_at: 100, duration_ms: 5, status_code: null, ok: false, error: null, response_snippet: null,
    };
    const ev = buildEvent(baseJob, result);
    expect(ev.error).toBeNull();
    expect(ev.status_code).toBeNull();
  });
});

describe("buildText", () => {
  it("formats the standard failure message", () => {
    const text = buildText({
      job_id: 42, job_name: "hello",
      error: "fetch timeout", status_code: null,
      started_at: 1776486572, duration_ms: 30001,
    });
    expect(text).toBe(
      `[OpenCron] job "hello" FAILED\n` +
      `error: fetch timeout\n` +
      `status: n/a\n` +
      `duration: 30001 ms\n` +
      `time: 2026-04-18T04:29:32Z`,
    );
  });

  it("substitutes (none) for null error and echoes status code", () => {
    const text = buildText({
      job_id: 1, job_name: "j",
      error: null, status_code: 502,
      started_at: 1776486572, duration_ms: 12,
    });
    expect(text).toContain("error: (none)");
    expect(text).toContain("status: 502");
  });
});
