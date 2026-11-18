import { computed, ref } from "vue";
import { api, scope } from "./api";
import { errorText } from "./format";
import type { AlertChannel, Execution, ExecutionWire, Job, Project, ScriptRuntime, Workspace } from "./types";

export const RECENT_LIMIT = 200;

export const jobs = ref<Job[]>([]);
export const recent = ref<Execution[]>([]);
export const runtimes = ref<ScriptRuntime[]>(["javascript"]);
export const loaded = ref(false);
export const loadError = ref("");

/** The workspaces this account belongs to, and the one the app is showing. */
export const workspaces = ref<Workspace[]>([]);
export const workspaceId = ref<string | null>(null);
export const workspace = computed(() => workspaces.value.find((item) => item.id === workspaceId.value) ?? null);
/** Owners and admins manage members, projects and keys; members work with jobs and secrets. */
export const canManage = computed(() => workspace.value?.role === "owner" || workspace.value?.role === "admin");

/** The projects of the current workspace, and the one the job list is narrowed to (`all` for every project). */
export const projects = ref<Project[]>([]);
export const projectFilter = ref("all");
export const projectsById = computed(() => new Map(projects.value.map((project) => [project.id, project])));

const projectKey = (id: string) => `opencron:project:${id}`;

function rememberedProject(id: string): string {
  try { return localStorage.getItem(projectKey(id)) ?? "all"; } catch { return "all"; }
}

/** The alert channels of the current workspace, loaded when a page needs them. */
export const channels = ref<AlertChannel[]>([]);
export const channelsById = computed(() => new Map(channels.value.map((channel) => [channel.id, channel])));

export async function loadChannels(): Promise<AlertChannel[]> {
  const asked = scope.workspace;
  // channels of every project, so a job's picker and its detail page can name all of them
  const { channels: list } = await api<{ channels: AlertChannel[] }>("/channels", { headers: { "x-project-id": "all" } });
  if (asked === scope.workspace) channels.value = list;
  return list;
}

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

/** Loads the project list of the current workspace and restores the project this browser last looked at. */
export async function loadProjects(): Promise<void> {
  const chosen = scope.project;
  scope.project = null;
  try {
    projects.value = (await api<{ projects: Project[] }>("/projects")).projects;
  } finally {
    scope.project = chosen;
  }
  const wanted = workspaceId.value ? rememberedProject(workspaceId.value) : "all";
  projectFilter.value = projectsById.value.has(wanted) ? wanted : "all";
  scope.project = projectFilter.value === "all" ? null : projectFilter.value;
}

/** Asks the API which workspace this session is in (it picks one when the saved one is gone). */
export async function loadWorkspace(): Promise<void> {
  scope.workspace = null;
  scope.project = null;
  const result = await api<{ workspaces: Workspace[]; current: string }>("/workspaces");
  workspaces.value = result.workspaces;
  workspaceId.value = result.current;
  scope.workspace = result.current;
  await loadProjects();
}

/** Loads the workspace, then its jobs and runs. */
export async function boot(): Promise<void> {
  try {
    await loadWorkspace();
  } catch (caught) {
    loadError.value = errorText(caught);
    loaded.value = true;
    return;
  }
  await refresh();
}

export async function switchWorkspace(id: string): Promise<void> {
  await api(`/workspaces/${encodeURIComponent(id)}/activate`, { method: "POST" });
  reset();
  await boot();
}

export function setProject(id: string): void {
  projectFilter.value = id;
  scope.project = id === "all" ? null : id;
  try {
    if (workspaceId.value) localStorage.setItem(projectKey(workspaceId.value), id);
  } catch {
    // private windows may refuse storage; the choice lasts for this page only
  }
  void refresh();
}

export async function refresh(): Promise<void> {
  if (!scope.workspace) return;
  const asked = `${scope.workspace}/${scope.project}`;
  try {
    const [jobsResponse, executionsResponse] = await Promise.all([
      api<{ jobs: Job[] }>("/jobs"),
      fetchExecutions("/executions", RECENT_LIMIT),
    ]);
    // A switch while this was loading makes the answer stale.
    if (asked !== `${scope.workspace}/${scope.project}`) return;
    jobs.value = jobsResponse.jobs;
    recent.value = executionsResponse;
    loadError.value = "";
  } catch (caught) {
    // Removed from this workspace, or it was deleted, while the page was open: go to another one.
    if (caught instanceof Error && caught.message === "Workspace not found" && scope.workspace) return boot();
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
  scope.workspace = null;
  scope.project = null;
  workspaces.value = [];
  workspaceId.value = null;
  projects.value = [];
  projectFilter.value = "all";
  channels.value = [];
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
