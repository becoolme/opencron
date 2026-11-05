import { computed, ref } from "vue";
import { api } from "./api";
import { errorText } from "./format";
import type { Execution, ExecutionWire, Job, ScriptRuntime } from "./types";

export const RECENT_LIMIT = 200;

export const jobs = ref<Job[]>([]);
export const recent = ref<Execution[]>([]);
export const runtimes = ref<ScriptRuntime[]>(["javascript"]);
export const loaded = ref(false);
export const loadError = ref("");

export const jobsById = computed(() => new Map(jobs.value.map((job) => [job.id, job])));

/** Recent executions per job, oldest first. */
export const recentByJob = computed(() => {
  const map = new Map<number, Execution[]>();
  for (const execution of recent.value) {
    const list = map.get(execution.job_id) ?? [];
    list.push(execution);
    map.set(execution.job_id, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.started_at - b.started_at);
  return map;
});

/** Fetches a page of executions from `path` (with `limit` and an optional `before` cursor). */
export async function fetchExecutions(path: string, limit: number, before?: number): Promise<Execution[]> {
  const query = `limit=${limit}${before ? `&before=${before}` : ""}`;
  const { executions } = await api<{ executions: ExecutionWire[] }>(`${path}?${query}`);
  return executions.map((e) => ({ ...e, ok: Boolean(e.ok) }));
}

export async function refresh(): Promise<void> {
  try {
    const [jobsResponse, executionsResponse] = await Promise.all([
      api<{ jobs: Job[] }>("/jobs"),
      fetchExecutions("/executions", RECENT_LIMIT),
    ]);
    jobs.value = jobsResponse.jobs;
    recent.value = executionsResponse;
    loadError.value = "";
  } catch (caught) {
    loadError.value = errorText(caught);
  } finally {
    loaded.value = true;
  }
}

export async function loadMeta(): Promise<void> {
  try {
    const meta = await api<{ runtimes: ScriptRuntime[] }>("/meta");
    if (meta.runtimes.length) runtimes.value = meta.runtimes;
  } catch {
    // keep the Cloudflare default
  }
}

export function reset(): void {
  jobs.value = [];
  recent.value = [];
  loaded.value = false;
  loadError.value = "";
}

/** HTTP and JavaScript jobs succeed on a 2xx response; Python and Go jobs on exit code 0. */
export function succeedsOn2xx(job: Pick<Job, "type" | "runtime">): boolean {
  return job.type === "url" || job.runtime === "javascript";
}

export type RunState = "ok" | "fail" | "paused" | "none";

export function jobState(job: Job): RunState {
  if (!job.enabled) return "paused";
  if (job.last_status === "failed") return "fail";
  if (job.last_status === "success") return "ok";
  return "none";
}

/**
 * Appends an older page to a list of runs. The API pages with `started_at < before`, and many runs can share a second
 * (jobs on the same cron minute), so callers ask for `before = last.started_at + 1` and the overlap is dropped here.
 * Returns whether the page brought anything new, so a page made only of duplicates ends the paging.
 */
export function appendPage(list: Execution[], page: Execution[]): { list: Execution[]; added: number } {
  const seen = new Set(list.map((run) => run.id));
  const fresh = page.filter((run) => !seen.has(run.id));
  return { list: [...list, ...fresh], added: fresh.length };
}
