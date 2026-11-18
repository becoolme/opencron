import { t } from "./i18n";
import { validCron } from "./format";
import type { HeaderRow, Job, JobForm, ScriptRuntime } from "./types";

export const TIMEOUT_MIN = 1_000;
export const TIMEOUT_MAX = 60_000;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export const TEMPLATES: Record<ScriptRuntime, string> = {
  javascript: `export default {
  async fetch(request, env) {
    const { jobId, jobName, scheduledAt } = await request.json();
    // Return a 2xx response to mark the run as successful.
    return Response.json({ ok: true, job: jobName, scheduledAt });
  },
};
`,
  python: `import json
import os

context = json.loads(os.environ["OPENCRON_CONTEXT"])

# Exit with code 0 to mark the run as successful.
# Anything printed to stdout is kept with the run.
print(f"hello from {context['jobName']}")
`,
  go: `package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	var ctx struct {
		JobID   int    \`json:"jobId"\`
		JobName string \`json:"jobName"\`
	}
	if err := json.Unmarshal([]byte(os.Getenv("OPENCRON_CONTEXT")), &ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Exit with code 0 to mark the run as successful.
	fmt.Println("hello from", ctx.JobName)
}
`,
};

export function emptyForm(): JobForm {
  return {
    id: null,
    name: "",
    type: "url",
    url: "",
    method: "GET",
    headers: [],
    body: "",
    script: TEMPLATES.javascript,
    runtime: "javascript",
    cron: "*/5 * * * *",
    timeout_ms: 30_000,
    enabled: true,
    channel_ids: [],
    last_notified_at: null,
    project_id: "",
  };
}

export function jobToForm(job: Job): JobForm {
  const runtime = job.runtime;
  return {
    id: job.id,
    name: job.name,
    type: job.type,
    url: job.url ?? "",
    method: job.method || "GET",
    headers: Object.entries(job.headers ?? {}).map(([key, value]) => ({ key, value })),
    body: job.body ?? "",
    script: job.script ?? TEMPLATES[runtime],
    runtime,
    cron: job.cron,
    timeout_ms: job.timeout_ms,
    enabled: job.enabled,
    channel_ids: [...job.channel_ids],
    last_notified_at: job.last_notified_at,
    project_id: job.project_id ?? "",
  };
}

export function methodHasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/** True when the script is empty or still one of the starting templates, so switching language can replace it. */
export function isTemplate(script: string): boolean {
  const trimmed = script.trim();
  return !trimmed || Object.values(TEMPLATES).some((template) => template.trim() === trimmed);
}

export type FormErrors = Partial<Record<"name" | "url" | "cron" | "headers" | "script" | "timeout_ms", string>>;

export function validateForm(form: JobForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = t("Give the job a name.");
  if (!validCron(form.cron)) {
    errors.cron = t("Use five fields: minute, hour, day of month, month, day of week.");
  }
  if (!Number.isInteger(form.timeout_ms) || form.timeout_ms < TIMEOUT_MIN || form.timeout_ms > TIMEOUT_MAX) {
    errors.timeout_ms = t("Choose a timeout between 1 and 60 seconds.");
  }
  if (form.type === "url") {
    if (!/^https?:\/\/\S+$/i.test(form.url.trim())) errors.url = t("Enter a URL starting with http:// or https://.");
    const keys = form.headers.map((row) => row.key.trim()).filter(Boolean);
    if (form.headers.some((row) => !row.key.trim() && row.value.trim())) {
      errors.headers = t("Every header value needs a name.");
    } else if (keys.some((key) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))) {
      errors.headers = t("Header names can't contain spaces or special characters.");
    } else if (new Set(keys.map((key) => key.toLowerCase())).size !== keys.length) {
      errors.headers = t("Each header name can appear only once.");
    }
  } else if (!form.script.trim()) {
    errors.script = t("The script is empty.");
  }
  return errors;
}

function headersObject(rows: HeaderRow[]): Record<string, string> | null {
  const entries = rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value] as const);
  return entries.length ? Object.fromEntries(entries) : null;
}

/** The request body for POST /jobs, or for PATCH /jobs/:id when editing (the type can't change). */
export function formToPayload(form: JobForm): Record<string, unknown> {
  const common = {
    name: form.name.trim(),
    cron: form.cron.trim(),
    enabled: form.enabled,
    timeout_ms: form.timeout_ms,
    channel_ids: form.channel_ids,
    ...(form.project_id ? { project_id: form.project_id } : {}),
  };
  const payload: Record<string, unknown> =
    form.type === "url"
      ? {
          ...common,
          type: "url",
          url: form.url.trim(),
          method: form.method,
          headers: headersObject(form.headers),
          body: methodHasBody(form.method) && form.body ? form.body : null,
        }
      : { ...common, type: "script", script: form.script, runtime: form.runtime };
  if (form.id !== null) delete payload.type;
  return payload;
}
