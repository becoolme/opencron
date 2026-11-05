<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, watch } from "vue";
import { api } from "./api";
import { authClient } from "./auth-client";
import AuthPanel from "./components/AuthPanel.vue";
import type { Execution, Job, JobForm, NotifyDraft, NotifyTarget, NotifyType } from "./types";

const CodeEditor = defineAsyncComponent(() => import("./components/CodeEditor.vue"));
const sessionState = authClient.useSession();
const session = computed(() => sessionState.value.data);
const sessionPending = computed(() => sessionState.value.isPending);
const sessionError = computed(() => sessionState.value.error);

const DEFAULT_SCRIPT = `export default {
  async fetch(request, env, ctx) {
    const { jobId, jobName, scheduledAt } = await request.json();
    const previous = await env.D1.get("run-count");
    const runs = Number(previous?.data ?? "0") + 1;
    const record = await env.D1.put("run-count", String(runs));
    return Response.json({ ok: true, job: jobName, runs, savedAt: record.updated_at });
  },
};
`;

function emptyForm(): JobForm {
  return {
    id: null,
    name: "",
    type: "url",
    url: "",
    method: "GET",
    headers: "",
    body: "",
    script: DEFAULT_SCRIPT,
    cron: "0 12 * * *",
    timeout_ms: 30_000,
    enabled: true,
    notify_targets: [],
    last_notified_at: null,
  };
}

function emptyNotifyDraft(): NotifyDraft {
  return {
    type: "slack",
    url: "",
    bot_token: "",
    chat_id: "",
    sign_secret: "",
    headers_text: "",
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fmt(timestamp: number | null | undefined): string {
  return timestamp
    ? new Date(timestamp * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")
    : "—";
}

const jobs = ref<Job[]>([]);
const recent = ref<Execution[]>([]);
const expanded = ref<number | null>(null);
const jobExecutions = reactive<Record<number, Execution[]>>({});
const error = ref("");
const form = ref<JobForm>(emptyForm());
const showModal = ref(false);
const showNotifyForm = ref(false);
const notifyDraft = ref<NotifyDraft>(emptyNotifyDraft());
const notifyError = ref("");

async function refresh(): Promise<void> {
  try {
    const [jobsResponse, executionsResponse] = await Promise.all([
      api<{ jobs: Job[] }>("/jobs"),
      api<{ executions: Execution[] }>("/executions?limit=50"),
    ]);
    jobs.value = jobsResponse.jobs;
    recent.value = executionsResponse.executions;
    error.value = "";
  } catch (caught) {
    error.value = errorText(caught);
  }
}

function resetNotifyForm(): void {
  showNotifyForm.value = false;
  notifyDraft.value = emptyNotifyDraft();
  notifyError.value = "";
}

function openCreate(): void {
  form.value = emptyForm();
  resetNotifyForm();
  showModal.value = true;
}

function openEdit(job: Job): void {
  form.value = {
    id: job.id,
    name: job.name,
    type: job.type,
    url: job.url ?? "",
    method: job.method,
    headers: job.headers ? JSON.stringify(job.headers, null, 2) : "",
    body: job.body ?? "",
    script: job.script ?? DEFAULT_SCRIPT,
    cron: job.cron,
    timeout_ms: job.timeout_ms,
    enabled: job.enabled,
    notify_targets: job.notify_targets ? structuredClone(job.notify_targets) : [],
    last_notified_at: job.last_notified_at ?? null,
  };
  resetNotifyForm();
  showModal.value = true;
}

function closeModal(): void {
  showModal.value = false;
  resetNotifyForm();
}

async function save(): Promise<void> {
  const current = form.value;
  let payload: Record<string, unknown>;

  if (current.type === "url") {
    let headers: Record<string, unknown> | null = null;
    if (current.headers.trim()) {
      try {
        const parsed: unknown = JSON.parse(current.headers);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          error.value = "headers must be a JSON object";
          return;
        }
        headers = parsed as Record<string, unknown>;
      } catch {
        error.value = "headers must be valid JSON";
        return;
      }
    }

    payload = {
      name: current.name,
      type: "url",
      url: current.url,
      method: current.method,
      headers,
      body: current.body || null,
      cron: current.cron,
      enabled: current.enabled,
      timeout_ms: Number(current.timeout_ms),
    };
  } else {
    payload = {
      name: current.name,
      type: "script",
      script: current.script,
      cron: current.cron,
      enabled: current.enabled,
      timeout_ms: Number(current.timeout_ms),
    };
  }

  payload.notify_targets = current.notify_targets.length ? current.notify_targets : null;

  try {
    if (current.id !== null) {
      const { type: _type, ...patch } = payload;
      await api<void>(`/jobs/${current.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    } else {
      await api<void>("/jobs", { method: "POST", body: JSON.stringify(payload) });
    }
    closeModal();
    await refresh();
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function toggleEnabled(job: Job): Promise<void> {
  try {
    await api<void>(`/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !job.enabled }),
    });
    await refresh();
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function runNow(job: Job): Promise<void> {
  try {
    await api<void>(`/jobs/${job.id}/run`, { method: "POST" });
    await refresh();
    if (expanded.value === job.id) await loadHistory(job.id);
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function remove(job: Job): Promise<void> {
  if (!confirm(`Delete "${job.name}"?`)) return;

  try {
    await api<void>(`/jobs/${job.id}`, { method: "DELETE" });
    await refresh();
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function toggleHistory(job: Job): Promise<void> {
  if (expanded.value === job.id) {
    expanded.value = null;
    return;
  }

  expanded.value = job.id;
  await loadHistory(job.id);
}

async function loadHistory(id: number): Promise<void> {
  try {
    const response = await api<{ executions: Execution[] }>(`/jobs/${id}/executions?limit=20`);
    jobExecutions[id] = response.executions;
  } catch (caught) {
    error.value = errorText(caught);
  }
}

function startNotifyDraft(): void {
  notifyDraft.value = emptyNotifyDraft();
  notifyError.value = "";
  showNotifyForm.value = true;
}

function cancelNotifyDraft(): void {
  resetNotifyForm();
}

function removeNotify(index: number): void {
  form.value.notify_targets.splice(index, 1);
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function hasSignSecret(target: NotifyTarget): boolean {
  return "sign_secret" in target && Boolean(target.sign_secret);
}

function urlPlaceholder(type: NotifyType): string {
  switch (type) {
    case "lark":
      return "https://open.feishu.cn/open-apis/bot/v2/hook/XXX";
    case "dingtalk":
      return "https://oapi.dingtalk.com/robot/send?access_token=XXX";
    case "slack":
      return "https://hooks.slack.com/services/…";
    case "discord":
      return "https://discord.com/api/webhooks/…";
    default:
      return "https://your-endpoint.example.com/hook";
  }
}

function commitNotifyDraft(): void {
  notifyError.value = "";
  const draft = notifyDraft.value;
  let target: NotifyTarget;

  if (draft.type === "telegram") {
    if (!draft.bot_token.trim() || !draft.chat_id.trim()) {
      notifyError.value = "bot_token and chat_id required";
      return;
    }
    target = {
      type: "telegram",
      bot_token: draft.bot_token.trim(),
      chat_id: draft.chat_id.trim(),
    };
  } else {
    const url = draft.url.trim();
    if (!url) {
      notifyError.value = "url required";
      return;
    }

    const scheme = draft.type === "http" ? /^https?:\/\// : /^https:\/\//;
    if (!scheme.test(url)) {
      notifyError.value = draft.type === "http" ? "must start with http:// or https://" : "must start with https://";
      return;
    }

    switch (draft.type) {
      case "http": {
        const httpTarget: Extract<NotifyTarget, { type: "http" }> = { type: "http", url };
        if (draft.headers_text.trim()) {
          try {
            const parsed: unknown = JSON.parse(draft.headers_text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              notifyError.value = "headers must be an object";
              return;
            }
            if (!Object.values(parsed).every((value) => typeof value === "string")) {
              notifyError.value = "header values must be strings";
              return;
            }
            httpTarget.headers = parsed as Record<string, string>;
          } catch {
            notifyError.value = "headers must be valid JSON";
            return;
          }
        }
        target = httpTarget;
        break;
      }
      case "lark":
      case "dingtalk":
        target = {
          type: draft.type,
          url,
          ...(draft.sign_secret.trim() ? { sign_secret: draft.sign_secret.trim() } : {}),
        };
        break;
      case "slack":
      case "discord":
        target = { type: draft.type, url };
        break;
    }
  }

  form.value.notify_targets.push(target);
  resetNotifyForm();
}

watch(
  () => session.value?.user.id,
  async (userId) => {
    if (userId) {
      await refresh();
      return;
    }

    jobs.value = [];
    recent.value = [];
    expanded.value = null;
    error.value = "";
  },
  { immediate: true },
);

async function handleAuthenticated(): Promise<void> {
  await sessionState.value.refetch();
}

async function signOut(): Promise<void> {
  await authClient.signOut();
  await sessionState.value.refetch();
  showModal.value = false;
}
</script>

<template>
  <main v-if="sessionPending" class="min-h-screen flex items-center justify-center text-sm text-slate-500">
    Loading OpenCron…
  </main>

  <AuthPanel v-else-if="!session" @authenticated="handleAuthenticated" />

  <div v-else class="max-w-6xl mx-auto p-6 space-y-6">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">OpenCron</h1>
      <div class="flex items-center gap-3">
        <div class="hidden sm:block text-right leading-tight">
          <div class="text-sm font-medium text-slate-800">{{ session.user.name }}</div>
          <div class="text-xs text-slate-500">{{ session.user.email }}</div>
        </div>
        <button type="button" class="text-sm px-3 py-2 border border-slate-300 rounded hover:bg-slate-50" @click="signOut">
          Sign out
        </button>
        <button type="button" class="bg-slate-900 text-white px-4 py-2 rounded hover:bg-slate-700" @click="openCreate">
          + New job
        </button>
      </div>
    </header>

    <div v-if="sessionError" class="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded">
      {{ sessionError.message }}
    </div>

    <div v-if="error" class="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded">
      {{ error }}
    </div>

    <section class="bg-white rounded shadow-sm border border-slate-200 overflow-x-auto">
      <table class="w-full min-w-4xl text-sm">
        <thead class="bg-slate-100 text-left">
          <tr>
            <th class="p-3">Name</th>
            <th class="p-3">Type</th>
            <th class="p-3">Target</th>
            <th class="p-3">Cron (UTC)</th>
            <th class="p-3">Last</th>
            <th class="p-3">Next</th>
            <th class="p-3 w-40"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="job in jobs" :key="job.id">
            <tr class="border-t border-slate-200 hover:bg-slate-50 cursor-pointer" @click="toggleHistory(job)">
              <td class="p-3 font-medium">{{ job.name }}</td>
              <td class="p-3">
                <span v-if="job.type === 'script'" class="text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-800">script</span>
                <span v-else class="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">url</span>
              </td>
              <td class="p-3 font-mono text-xs truncate max-w-xs">
                <span v-if="job.type === 'url'">{{ job.method }} {{ job.url }}</span>
                <span v-else class="text-slate-500">script v{{ job.script_version }}</span>
              </td>
              <td class="p-3 font-mono text-xs">{{ job.cron }}</td>
              <td class="p-3">
                <span v-if="job.last_status === 'success'" class="text-green-700">✓ {{ fmt(job.last_run_at) }}</span>
                <span v-else-if="job.last_status === 'failed'" class="text-red-700">✗ {{ fmt(job.last_run_at) }}</span>
                <span v-else class="text-slate-400">never</span>
              </td>
              <td class="p-3 text-slate-600">{{ job.enabled ? fmt(job.next_run_at) : "disabled" }}</td>
              <td class="p-3 text-right whitespace-nowrap space-x-1" @click.stop>
                <button type="button" class="text-xs px-2 py-1 border rounded" @click="runNow(job)">Run</button>
                <button type="button" class="text-xs px-2 py-1 border rounded" @click="openEdit(job)">Edit</button>
                <button type="button" class="text-xs px-2 py-1 border rounded" @click="toggleEnabled(job)">
                  {{ job.enabled ? "Disable" : "Enable" }}
                </button>
                <button type="button" class="text-xs px-2 py-1 border rounded text-red-700" @click="remove(job)">Del</button>
              </td>
            </tr>
            <tr v-if="expanded === job.id" class="bg-slate-50">
              <td colspan="7" class="p-3">
                <div v-if="!jobExecutions[job.id]" class="text-slate-500">Loading…</div>
                <div v-else-if="jobExecutions[job.id].length === 0" class="text-slate-500">No executions yet.</div>
                <table v-else class="w-full text-xs">
                  <thead class="text-left text-slate-500">
                    <tr>
                      <th>When</th>
                      <th>Status</th>
                      <th>Duration</th>
                      <th>Error / Response</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="execution in jobExecutions[job.id]" :key="execution.id" class="border-t border-slate-200">
                      <td class="py-1">{{ fmt(execution.started_at) }}</td>
                      <td class="py-1">
                        <span v-if="execution.ok" class="text-green-700">{{ execution.status_code }}</span>
                        <span v-else class="text-red-700">{{ execution.status_code ?? "ERR" }}</span>
                      </td>
                      <td class="py-1">{{ execution.duration_ms }}ms</td>
                      <td class="py-1 font-mono truncate max-w-xl">{{ execution.error ?? execution.response_snippet ?? "" }}</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
          <tr v-if="jobs.length === 0">
            <td colspan="7" class="p-6 text-center text-slate-500">No jobs yet.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="bg-white rounded shadow-sm border border-slate-200">
      <header class="px-4 py-3 border-b border-slate-200 font-medium">Recent activity</header>
      <ul class="divide-y divide-slate-200 text-sm">
        <li v-for="execution in recent" :key="execution.id" class="px-4 py-2 flex items-center gap-3">
          <span v-if="execution.ok" class="text-green-700 font-mono">{{ execution.status_code }}</span>
          <span v-else class="text-red-700 font-mono">{{ execution.status_code ?? "ERR" }}</span>
          <span class="text-slate-600">job #{{ execution.job_id }}</span>
          <span class="text-slate-500">{{ execution.duration_ms }}ms</span>
          <span class="text-slate-400 ml-auto">{{ fmt(execution.started_at) }}</span>
        </li>
        <li v-if="recent.length === 0" class="px-4 py-6 text-center text-slate-500">Nothing yet.</li>
      </ul>
    </section>

    <div v-if="showModal" class="fixed inset-0 z-10 bg-black/40 flex items-center justify-center p-4" @click.self="closeModal">
      <div class="bg-white rounded w-full max-w-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <h2 class="text-lg font-semibold">{{ form.id ? "Edit job" : "New job" }}</h2>

        <div v-if="!form.id" class="flex gap-2">
          <label class="text-sm"><input v-model="form.type" type="radio" value="url" class="mr-1" /> URL</label>
          <label class="text-sm"><input v-model="form.type" type="radio" value="script" class="mr-1" /> Script</label>
        </div>
        <div v-else class="text-xs text-slate-500">
          Type: <span class="font-mono">{{ form.type }}</span> (immutable)
        </div>

        <label class="block text-sm">
          Name
          <input v-model="form.name" class="mt-1 w-full border rounded p-2" />
        </label>

        <template v-if="form.type === 'url'">
          <label class="block text-sm">
            URL
            <input v-model="form.url" class="mt-1 w-full border rounded p-2 font-mono text-xs" />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">
              Method
              <select v-model="form.method" class="mt-1 w-full border rounded p-2">
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
                <option>PATCH</option>
                <option>DELETE</option>
                <option>HEAD</option>
              </select>
            </label>
            <label class="text-sm">
              Cron (UTC)
              <input v-model="form.cron" class="mt-1 w-full border rounded p-2 font-mono text-xs" />
            </label>
          </div>
          <label class="block text-sm">
            Headers (JSON, optional)
            <textarea v-model="form.headers" rows="3" class="mt-1 w-full border rounded p-2 font-mono text-xs" placeholder='{"X-Api-Key":"..."}'></textarea>
          </label>
          <label class="block text-sm">
            Body (optional)
            <textarea v-model="form.body" rows="3" class="mt-1 w-full border rounded p-2 font-mono text-xs"></textarea>
          </label>
        </template>

        <template v-else>
          <label class="block text-sm">
            Cron (UTC)
            <input v-model="form.cron" class="mt-1 w-full border rounded p-2 font-mono text-xs" />
          </label>
          <label class="block text-sm">Script (module Worker)</label>
          <CodeEditor v-model="form.script" />
          <p class="text-xs text-slate-500">
            Bindings: env.db · env.D1 · env.KV
          </p>
        </template>

        <div class="grid grid-cols-2 gap-3 items-end">
          <label class="text-sm">
            Timeout (ms)
            <input v-model.number="form.timeout_ms" type="number" class="mt-1 w-full border rounded p-2" />
          </label>
          <label class="text-sm inline-flex items-center gap-2">
            <input v-model="form.enabled" type="checkbox" /> Enabled
          </label>
        </div>

        <div class="border-t border-slate-200 pt-4">
          <div class="flex items-center justify-between mb-2">
            <label class="block text-sm font-medium">Notifications (on failure)</label>
            <span class="text-xs text-slate-500">{{ form.notify_targets.length }} configured</span>
          </div>

          <div v-if="form.notify_targets.length" class="space-y-2 mb-2">
            <div
              v-for="(target, index) in form.notify_targets"
              :key="index"
              class="flex items-start justify-between bg-slate-50 rounded p-2"
            >
              <div class="text-xs font-mono">
                <span class="inline-block px-1.5 py-0.5 rounded bg-slate-200 text-slate-800 mr-2">{{ target.type }}</span>
                <span v-if="target.type === 'telegram'">bot: {{ maskToken(target.bot_token) }} → {{ target.chat_id }}</span>
                <span v-else>{{ target.url }}</span>
                <span v-if="hasSignSecret(target)" class="ml-2 text-slate-400">(signed)</span>
              </div>
              <button type="button" class="text-red-600 text-sm hover:underline" @click="removeNotify(index)">✕</button>
            </div>
          </div>

          <div v-if="showNotifyForm" class="bg-slate-50 rounded p-2 space-y-2">
            <select v-model="notifyDraft.type" class="w-full border rounded px-2 py-1 text-sm">
              <option value="http">http (generic JSON POST)</option>
              <option value="lark">lark (飞书)</option>
              <option value="telegram">telegram</option>
              <option value="dingtalk">dingtalk (钉钉)</option>
              <option value="slack">slack</option>
              <option value="discord">discord</option>
            </select>

            <template v-if="notifyDraft.type === 'telegram'">
              <input v-model="notifyDraft.bot_token" placeholder="bot_token (e.g. 123456:ABC...)" class="w-full border rounded px-2 py-1 text-sm" />
              <input v-model="notifyDraft.chat_id" placeholder="chat_id (e.g. -1001234567890)" class="w-full border rounded px-2 py-1 text-sm" />
            </template>
            <template v-else>
              <input v-model="notifyDraft.url" :placeholder="urlPlaceholder(notifyDraft.type)" class="w-full border rounded px-2 py-1 text-sm" />
              <input
                v-if="notifyDraft.type === 'lark' || notifyDraft.type === 'dingtalk'"
                v-model="notifyDraft.sign_secret"
                placeholder="sign_secret (optional)"
                class="w-full border rounded px-2 py-1 text-sm"
              />
              <textarea
                v-if="notifyDraft.type === 'http'"
                v-model="notifyDraft.headers_text"
                rows="2"
                placeholder='headers JSON, e.g. {"x-api-key":"..."}'
                class="w-full border rounded px-2 py-1 text-sm font-mono"
              ></textarea>
            </template>

            <div v-if="notifyError" class="text-sm text-red-600">{{ notifyError }}</div>
            <div class="flex gap-2">
              <button type="button" class="bg-slate-800 text-white text-sm px-3 py-1 rounded" @click="commitNotifyDraft">Add</button>
              <button type="button" class="text-slate-600 text-sm px-3 py-1" @click="cancelNotifyDraft">Cancel</button>
            </div>
          </div>

          <button v-else type="button" class="text-sm text-indigo-700 hover:underline" @click="startNotifyDraft">
            + Add notification
          </button>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="px-3 py-2 rounded border" @click="closeModal">Cancel</button>
          <button type="button" class="px-3 py-2 rounded bg-slate-900 text-white" @click="save">Save</button>
        </div>
      </div>
    </div>
  </div>
</template>
