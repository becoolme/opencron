import { describe, expect, it } from "vitest";
import { emptyForm, formToPayload, isTemplate, jobToForm, TEMPLATES, validateForm } from "./job-form";
import { appendPage } from "./store";
import type { Execution, Job, JobForm } from "./types";

function form(patch: Partial<JobForm>): JobForm {
  return { ...emptyForm(), name: "Backup", url: "https://example.com/run", ...patch };
}

const job: Job = {
  id: 7,
  name: "Ping",
  type: "url",
  url: "https://example.com/ping",
  method: "POST",
  headers: { authorization: "Bearer x" },
  body: "{}",
  script: null,
  script_version: 1,
  runtime: "javascript",
  cron: "0 * * * *",
  timeout_ms: 10_000,
  enabled: false,
  notify_targets: [{ type: "slack", url: "https://hooks.slack.com/services/a" }],
  last_notified_at: null,
  project_id: "pj_1",
  last_status: null,
  last_run_at: null,
  next_run_at: 1_800_000_000,
  created_at: 1_790_000_000,
  updated_at: 1_790_000_000,
};

describe("validateForm", () => {
  it("passes a complete URL job", () => {
    expect(validateForm(form({}))).toEqual({});
  });

  it("flags each bad field", () => {
    const errors = validateForm(form({ name: " ", url: "example.com", cron: "* * *", timeout_ms: 90_000 }));
    expect(Object.keys(errors).sort()).toEqual(["cron", "name", "timeout_ms", "url"]);
  });

  it("checks header rows", () => {
    expect(validateForm(form({ headers: [{ key: "", value: "x" }] })).headers).toBeTruthy();
    expect(validateForm(form({ headers: [{ key: "bad name", value: "x" }] })).headers).toBeTruthy();
    expect(validateForm(form({ headers: [{ key: "X-A", value: "1" }, { key: "x-a", value: "2" }] })).headers).toBeTruthy();
    expect(validateForm(form({ headers: [{ key: "", value: "" }, { key: "X-A", value: "1" }] })).headers).toBeUndefined();
  });

  it("needs a script for script jobs, not a URL", () => {
    expect(validateForm(form({ type: "script", url: "", script: "  " }))).toEqual({ script: expect.any(String) });
  });
});

describe("formToPayload", () => {
  it("builds a URL job without a body for GET", () => {
    const payload = formToPayload(form({ method: "GET", body: "ignored", headers: [{ key: " X-A ", value: "1" }, { key: "", value: "" }] }));
    expect(payload).toEqual({
      name: "Backup",
      type: "url",
      url: "https://example.com/run",
      method: "GET",
      headers: { "X-A": "1" },
      body: null,
      cron: "*/5 * * * *",
      enabled: true,
      timeout_ms: 30_000,
      notify_targets: null,
    });
  });

  it("sends only script fields for a script job", () => {
    const payload = formToPayload(form({ type: "script", runtime: "python", script: "print(1)" }));
    expect(payload).toMatchObject({ type: "script", runtime: "python", script: "print(1)" });
    expect(payload).not.toHaveProperty("url");
    expect(payload).not.toHaveProperty("method");
  });

  it("leaves the type out when editing", () => {
    expect(formToPayload({ ...jobToForm(job) })).not.toHaveProperty("type");
  });
});

describe("jobToForm", () => {
  it("round-trips a job", () => {
    const back = formToPayload(jobToForm(job));
    expect(back).toEqual({
      name: "Ping",
      url: "https://example.com/ping",
      method: "POST",
      headers: { authorization: "Bearer x" },
      body: "{}",
      cron: "0 * * * *",
      enabled: false,
      timeout_ms: 10_000,
      notify_targets: job.notify_targets,
      project_id: "pj_1",
    });
  });

  it("copies alert targets so edits don't touch the cached job", () => {
    const edited = jobToForm(job);
    edited.notify_targets.pop();
    expect(job.notify_targets).toHaveLength(1);
  });
});

describe("isTemplate", () => {
  it("treats empty and untouched templates as replaceable", () => {
    expect(isTemplate("")).toBe(true);
    expect(isTemplate(TEMPLATES.python)).toBe(true);
    expect(isTemplate(`${TEMPLATES.go}\n`)).toBe(true);
    expect(isTemplate("print('mine')")).toBe(false);
  });
});

describe("appendPage", () => {
  const run = (id: number, started_at: number): Execution => ({
    id, job_id: 1, started_at, ok: true, status_code: 200, duration_ms: 5, error: null, response_snippet: null,
  });

  it("drops the overlap of an inclusive cursor", () => {
    const page = appendPage([run(3, 100), run(2, 90)], [run(2, 90), run(1, 90), run(0, 80)]);
    expect(page.list.map((r) => r.id)).toEqual([3, 2, 1, 0]);
    expect(page.added).toBe(2);
  });

  it("reports when a page brings nothing new", () => {
    expect(appendPage([run(2, 90)], [run(2, 90)]).added).toBe(0);
  });
});
