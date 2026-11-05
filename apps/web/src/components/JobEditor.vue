<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { api } from "../api";
import { t } from "../i18n";
import { clock, dayLabel, describeCron, errorText, nextRuns, relative } from "../format";
import { emptyForm, formToPayload, isTemplate, jobToForm, methodHasBody, METHODS, TEMPLATES, validateForm, type FormErrors } from "../job-form";
import { go, href } from "../router";
import { jobsById, refresh, runtimes } from "../store";
import type { Job, JobForm, JobType, ScriptRuntime } from "../types";
import Icon from "./Icon.vue";
import NotifyEditor from "./NotifyEditor.vue";

const CodeEditor = defineAsyncComponent(() => import("./CodeEditor.vue"));

const props = defineProps<{ id?: number }>();
const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail"] }>();

const editing = computed(() => props.id !== undefined);
const source = computed<Job | undefined>(() => (props.id === undefined ? undefined : jobsById.value.get(props.id)));

const form = ref<JobForm>(emptyForm());
const initial = ref("");
const errors = ref<FormErrors>({});
const submitted = ref(false);
const saving = ref(false);
const saveError = ref("");

// Load the job once; later background refreshes must not overwrite what the user is typing.
const stopLoading = watch(
  source,
  (job) => {
    if (editing.value && !job) return;
    queueMicrotask(() => stopLoading());
    form.value = job ? jobToForm(job) : emptyForm();
    initial.value = JSON.stringify(form.value);
    submitted.value = false;
    errors.value = {};
  },
  { immediate: true },
);

const dirty = computed(() => JSON.stringify(form.value) !== initial.value);

// Errors show after the first save attempt, then update as the user types.
watch(form, () => {
  if (submitted.value) errors.value = validateForm(form.value);
}, { deep: true });

const RUNTIME_LABEL: Record<ScriptRuntime, string> = { javascript: "JavaScript", python: "Python", go: "Go" };
const offeredRuntimes = computed<ScriptRuntime[]>(() => {
  const list = [...runtimes.value];
  if (!list.includes(form.value.runtime)) list.push(form.value.runtime);
  return list;
});
const onCloudflare = computed(() => runtimes.value.length === 1);

function setType(type: JobType): void {
  if (!editing.value) form.value.type = type;
}

function setRuntime(runtime: ScriptRuntime): void {
  if (runtime === form.value.runtime) return;
  if (isTemplate(form.value.script)) form.value.script = TEMPLATES[runtime];
  form.value.runtime = runtime;
}

function addHeader(): void {
  form.value.headers.push({ key: "", value: "" });
}

function removeHeader(index: number): void {
  form.value.headers.splice(index, 1);
}

const PRESETS = [
  { cron: "*/5 * * * *", en: "Every 5 min", zh: "每 5 分钟" },
  { cron: "0 * * * *", en: "Hourly", zh: "每小时" },
  { cron: "0 3 * * *", en: "Daily 03:00", zh: "每天 03:00" },
  { cron: "30 9 * * 1-5", en: "Weekdays 09:30", zh: "工作日 09:30" },
  { cron: "15 2 * * 0", en: "Sundays 02:15", zh: "每周日 02:15" },
  { cron: "0 8 1 * *", en: "Monthly", zh: "每月 1 日" },
];
const cronInput = ref<HTMLInputElement | null>(null);
const presetOn = computed(() => PRESETS.find((preset) => preset.cron === form.value.cron.trim())?.cron ?? "custom");

function pickPreset(cron: string | null): void {
  if (cron) {
    form.value.cron = cron;
    return;
  }
  void nextTick(() => cronInput.value?.focus());
}

const cronFields = computed(() => {
  const parts = form.value.cron.trim().split(/\s+/);
  const labels = [t("minute", "分"), t("hour", "时"), t("day", "日"), t("month", "月"), t("weekday", "周")];
  return labels.map((label, i) => ({ label, value: parts[i] ?? "" }));
});
const cronLive = computed(() => (validateForm({ ...form.value, name: "x" }).cron ? null : form.value.cron));
const cronText = computed(() => (cronLive.value ? describeCron(cronLive.value) : null));
const upcoming = computed(() => (cronLive.value ? nextRuns(cronLive.value, 5) : []));

const TIMEOUTS = [1, 5, 10, 15, 30, 45, 60].map((s) => s * 1000);
const timeoutOptions = computed(() => [...new Set([...TIMEOUTS, form.value.timeout_ms])].sort((a, b) => a - b));

const FIELD_ORDER = ["name", "url", "headers", "script", "cron", "timeout_ms"] as const;

async function save(): Promise<void> {
  submitted.value = true;
  saveError.value = "";
  errors.value = validateForm(form.value);
  const first = FIELD_ORDER.find((key) => errors.value[key]);
  if (first) {
    await nextTick();
    document.getElementById(`f-${first}`)?.focus();
    return;
  }

  saving.value = true;
  try {
    const payload = formToPayload(form.value);
    let id = props.id;
    if (editing.value) {
      await api(`/jobs/${props.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      const { job } = await api<{ job: Job }>("/jobs", { method: "POST", body: JSON.stringify(payload) });
      id = job.id;
    }
    await refresh();
    initial.value = JSON.stringify(form.value);
    emit("toast", editing.value ? t("Changes saved", "已保存修改") : t("Job created", "任务已创建"), "ok");
    go(href.job(id!));
  } catch (caught) {
    saveError.value = errorText(caught);
  } finally {
    saving.value = false;
  }
}

function cancel(): void {
  if (dirty.value && !confirm(t("Discard your changes?", "放弃未保存的修改？"))) return;
  initial.value = JSON.stringify(form.value);
  go(editing.value ? href.job(props.id!) : href.jobs);
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value && !saving.value) event.preventDefault();
}
window.addEventListener("beforeunload", onBeforeUnload);
onBeforeUnmount(() => window.removeEventListener("beforeunload", onBeforeUnload));
</script>

<template>
  <div v-if="editing && !source" class="card" style="padding: 40px; text-align: center">
    <p class="serif" style="font-size: 24px; margin: 0">{{ t("Job not found", "找不到这个任务") }}</p>
    <p class="muted"><a class="link" :href="href.jobs">{{ t("Back to cron jobs", "返回定时任务") }}</a></p>
  </div>

  <form v-else class="editor" novalidate @submit.prevent="save">
    <div class="hd" style="padding-bottom: 28px">
      <div>
        <span class="eyebrow">{{ editing ? t("Edit job", "编辑任务") : t("New job", "新建任务") }}</span>
        <h1 class="serif" style="margin: 14px 0 0; overflow-wrap: anywhere">{{ editing ? source?.name : t("Schedule something", "安排一个任务") }}</h1>
      </div>
    </div>

    <div class="cols">
      <div class="card main-col">
        <section class="sect">
          <h3 class="serif">{{ t("What runs", "运行什么") }}</h3>
          <div class="kinds" role="radiogroup" :aria-label="t('Job type', '任务类型')">
            <button type="button" role="radio" class="kind" :class="{ on: form.type === 'url' }" :aria-checked="form.type === 'url'" :disabled="editing" @click="setType('url')">
              <span style="display: flex; gap: 8px; align-items: center; font-weight: 500"><Icon name="globe" />{{ t("Call a URL", "请求一个 URL") }}</span>
              <small class="muted">{{ t("Send an HTTP request on schedule. 2xx counts as success.", "按计划发送 HTTP 请求，2xx 视为成功。") }}</small>
            </button>
            <button type="button" role="radio" class="kind" :class="{ on: form.type === 'script' }" :aria-checked="form.type === 'script'" :disabled="editing" @click="setType('script')">
              <span style="display: flex; gap: 8px; align-items: center; font-weight: 500"><Icon name="code" />{{ t("Run a script", "运行一段脚本") }}</span>
              <small class="muted">{{ onCloudflare ? t("JavaScript in an isolated Worker.", "在隔离的 Worker 中运行 JavaScript。") : t("JavaScript, Python or Go in a sandbox.", "在沙箱中运行 JavaScript、Python 或 Go。") }}</small>
            </button>
          </div>
          <small v-if="editing" class="faint" style="margin-top: -8px">{{ t("The type can't change after a job is created.", "任务创建后类型不可更改。") }}</small>

          <label class="fld">
            <span>{{ t("Name", "名称") }}</span>
            <input id="f-name" v-model="form.name" class="in" :class="{ bad: errors.name }" maxlength="200" :placeholder="t('Nightly backup', '每晚备份')" :aria-invalid="!!errors.name" :aria-describedby="errors.name ? 'e-name' : undefined" />
            <small v-if="errors.name" id="e-name" class="err">{{ errors.name }}</small>
          </label>
        </section>

        <section v-if="form.type === 'url'" class="sect">
          <h3 class="serif">{{ t("Request", "请求") }}</h3>
          <div class="req">
            <label class="fld" style="flex: 0 0 120px">
              <span>{{ t("Method", "方法") }}</span>
              <select v-model="form.method" class="in mono">
                <option v-for="method in METHODS" :key="method">{{ method }}</option>
              </select>
            </label>
            <label class="fld" style="flex: 1 1 260px">
              <span>URL</span>
              <input id="f-url" v-model="form.url" class="in mono" :class="{ bad: errors.url }" type="url" inputmode="url" spellcheck="false" autocomplete="off" placeholder="https://example.com/cron/cleanup" :aria-invalid="!!errors.url" :aria-describedby="errors.url ? 'e-url' : undefined" />
            </label>
          </div>
          <p v-if="errors.url" id="e-url" class="err-note" style="margin-top: -8px">{{ errors.url }}</p>

          <div class="fld">
            <span>{{ t("Headers", "请求头") }} <small class="faint">{{ t("optional", "可选") }}</small></span>
            <div v-for="(row, index) in form.headers" :key="index" class="hrow">
              <input :id="index === 0 ? 'f-headers' : undefined" v-model="row.key" class="in mono" :class="{ bad: errors.headers }" spellcheck="false" autocomplete="off" :placeholder="t('Name', '名称')" :aria-label="t(`Header ${index + 1} name`, `请求头 ${index + 1} 名称`)" />
              <input v-model="row.value" class="in mono" spellcheck="false" autocomplete="off" :placeholder="t('Value', '值')" :aria-label="t(`Header ${index + 1} value`, `请求头 ${index + 1} 值`)" />
              <button type="button" class="btn sm icon" :aria-label="t(`Remove header ${index + 1}`, `删除请求头 ${index + 1}`)" @click="removeHeader(index)"><Icon name="x" :size="14" /></button>
            </div>
            <small v-if="errors.headers" id="e-headers" class="err" role="alert">{{ errors.headers }}</small>
            <button type="button" class="btn sm" style="width: max-content" @click="addHeader"><Icon name="plus" :size="14" />{{ t("Add header", "添加请求头") }}</button>
          </div>

          <label v-if="methodHasBody(form.method)" class="fld">
            <span>{{ t("Body", "请求体") }} <small class="faint">{{ t("optional", "可选") }}</small></span>
            <textarea v-model="form.body" class="in mono" rows="4" spellcheck="false" placeholder='{"task": "cleanup"}'></textarea>
            <small>{{ t("Sent as is. Add a Content-Type header if the endpoint needs one.", "原样发送。如有需要，请自行添加 Content-Type 请求头。") }}</small>
          </label>
        </section>

        <section v-else class="sect">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap">
            <h3 class="serif">{{ t("Script", "脚本") }}</h3>
            <div v-if="offeredRuntimes.length > 1" class="seg" role="radiogroup" :aria-label="t('Language', '语言')">
              <button
                v-for="runtime in offeredRuntimes"
                :key="runtime"
                type="button"
                role="radio"
                :class="{ on: form.runtime === runtime }"
                :aria-checked="form.runtime === runtime"
                :disabled="!runtimes.includes(runtime)"
                @click="setRuntime(runtime)"
              >
                {{ RUNTIME_LABEL[runtime] }}
              </button>
            </div>
          </div>
          <div id="f-script" class="code-shell" tabindex="-1">
            <div class="bar">
              <span>{{ { javascript: "main.js", python: "main.py", go: "main.go" }[form.runtime] }}</span>
              <span style="color: #8b948e">{{ form.runtime === "javascript" ? t("2xx response = success", "返回 2xx 即成功") : t("exit 0 = success", "退出码 0 即成功") }}</span>
            </div>
            <CodeEditor v-model="form.script" :language="form.runtime" :label="t('Script source', '脚本源码')" />
          </div>
          <p v-if="errors.script" id="e-script" class="err-note" role="alert">{{ errors.script }}</p>
          <p v-if="!runtimes.includes(form.runtime)" class="alert" style="margin: 0">
            {{ t(`This deployment can't run ${RUNTIME_LABEL[form.runtime]}. Switch to JavaScript or run OpenCron with Docker.`, `当前部署无法运行 ${RUNTIME_LABEL[form.runtime]}。请改用 JavaScript，或使用 Docker 部署 OpenCron。`) }}
          </p>
        </section>

        <section class="sect">
          <h3 class="serif">{{ t("Schedule", "计划") }}</h3>
          <div class="presets" role="radiogroup" :aria-label="t('Common schedules', '常用计划')">
            <button v-for="preset in PRESETS" :key="preset.cron" type="button" role="radio" class="preset" :class="{ on: presetOn === preset.cron }" :aria-checked="presetOn === preset.cron" @click="pickPreset(preset.cron)">
              {{ t(preset.en, preset.zh) }}
            </button>
            <button type="button" role="radio" class="preset" :class="{ on: presetOn === 'custom' }" :aria-checked="presetOn === 'custom'" @click="pickPreset(null)">{{ t("Custom", "自定义") }}</button>
          </div>
          <div class="cfs" aria-hidden="true">
            <div v-for="field in cronFields" :key="field.label" class="cf"><b>{{ field.value || "·" }}</b><span>{{ field.label }}</span></div>
          </div>
          <label class="fld">
            <span>{{ t("Cron expression", "cron 表达式") }} <small class="faint">UTC</small></span>
            <input id="f-cron" ref="cronInput" v-model="form.cron" class="in mono" :class="{ bad: errors.cron }" spellcheck="false" autocomplete="off" placeholder="*/5 * * * *" :aria-invalid="!!errors.cron" :aria-describedby="errors.cron ? 'e-cron' : undefined" />
            <small v-if="errors.cron" id="e-cron" class="err">{{ errors.cron }}</small>
            <small v-else-if="cronText">{{ cronText }}</small>
            <small v-else-if="!cronLive" class="err">{{ t("Not a valid cron expression yet.", "还不是有效的 cron 表达式。") }}</small>
          </label>
        </section>

        <section class="sect">
          <h3 class="serif">{{ t("Run settings", "运行设置") }}</h3>
          <div class="req">
            <label class="fld" style="flex: 0 1 200px">
              <span>{{ t("Timeout", "超时") }}</span>
              <select id="f-timeout_ms" v-model.number="form.timeout_ms" class="in" :aria-invalid="!!errors.timeout_ms" :aria-describedby="errors.timeout_ms ? 'e-timeout_ms' : undefined">
                <option v-for="ms in timeoutOptions" :key="ms" :value="ms">{{ ms / 1000 }} {{ t("seconds", "秒") }}</option>
              </select>
              <small v-if="errors.timeout_ms" id="e-timeout_ms" class="err">{{ errors.timeout_ms }}</small>
            </label>
            <div class="fld" style="flex: 1 1 240px">
              <span id="enabled-label">{{ t("Status", "状态") }}</span>
              <div style="display: flex; align-items: center; gap: 10px; height: 44px">
                <button type="button" role="switch" class="tg" :class="{ on: form.enabled }" :aria-checked="form.enabled" aria-labelledby="enabled-label" @click="form.enabled = !form.enabled"></button>
                <span style="font-weight: 400">{{ form.enabled ? t("Runs on schedule", "按计划运行") : t("Paused, won't run", "已暂停，不会运行") }}</span>
              </div>
            </div>
          </div>
        </section>

        <section class="sect">
          <div>
            <h3 class="serif">{{ t("Alerts", "告警") }}</h3>
            <p class="muted" style="margin: 6px 0 0; font-size: 14px">{{ t("Notified when a run fails.", "运行失败时通知。") }}</p>
          </div>
          <NotifyEditor v-model="form.notify_targets" />
        </section>
      </div>

      <aside class="side-col">
        <section class="card pad">
          <h3 class="serif" style="margin-bottom: 14px">{{ t("Next 5 runs", "接下来 5 次") }}</h3>
          <div v-if="upcoming.length">
            <div v-for="(at, i) in upcoming" :key="at" class="nr">
              <span class="muted">{{ dayLabel(at) }}<template v-if="i === 0"> · {{ relative(at) }}</template></span>
              <b class="mono" style="font-weight: 500; font-size: 13.5px">{{ clock(at) }}</b>
            </div>
            <p class="faint" style="margin: 12px 0 0; font-size: 12.5px">{{ t("Shown in your time zone.", "按你的时区显示。") }}</p>
          </div>
          <p v-else class="muted" style="margin: 0; font-size: 14px">{{ t("Enter a valid cron expression to preview.", "填写有效的 cron 表达式即可预览。") }}</p>
        </section>

        <section v-if="form.type === 'script'" class="card pad">
          <h3 class="serif" style="margin-bottom: 10px">{{ t("Where it runs", "运行环境") }}</h3>
          <template v-if="form.runtime === 'javascript' && onCloudflare">
            <p class="muted note">{{ t("Each run gets its own Worker isolate without network access. Your fetch handler receives the job ID, name and scheduled time.", "每次运行都在独立的 Worker 隔离环境中进行，无法访问网络。fetch 处理函数会收到任务 ID、名称和计划时间。") }}</p>
            <p class="muted note">{{ t("env.KV and env.D1 keep data for this job between runs.", "env.KV 和 env.D1 可在多次运行之间为本任务保存数据。") }}</p>
          </template>
          <template v-else>
            <p class="muted note">{{ t("Each run starts a fresh container with no network, a read-only file system and a non-root user.", "每次运行都启动一个新容器：无网络、只读文件系统、非 root 用户。") }}</p>
            <p class="muted note">{{ t("The run context is JSON in OPENCRON_CONTEXT. Stdout is kept with the run; stderr becomes the error.", "运行上下文以 JSON 形式放在 OPENCRON_CONTEXT 中。标准输出随运行保存，标准错误作为错误信息。") }}</p>
            <p v-if="form.runtime === 'go'" class="muted note">{{ t("Go compiles on every run, so allow time for the build.", "Go 每次运行都会编译，请预留编译时间。") }}</p>
          </template>
        </section>
      </aside>
    </div>

    <div class="savebar">
      <p v-if="saveError" class="alert" role="alert" style="margin: 0; flex: 1 1 100%">{{ saveError }}</p>
      <p v-else-if="submitted && Object.keys(errors).length" class="err-note" role="status">{{ t("Fix the highlighted fields to save.", "请先修正标出的字段。") }}</p>
      <span v-else class="faint" style="font-size: 13px">{{ dirty ? t("Unsaved changes", "有未保存的修改") : "" }}</span>
      <div style="display: flex; gap: 10px; margin-left: auto">
        <button type="button" class="btn" @click="cancel">{{ t("Cancel", "取消") }}</button>
        <button type="submit" class="btn primary" :disabled="saving">{{ saving ? t("Saving…", "保存中…") : editing ? t("Save changes", "保存修改") : t("Create job", "创建任务") }}</button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: 24px; }
.cols { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start; }
.main-col { flex: 999 1 520px; min-width: 0; padding: 0; }
.side-col { flex: 1 1 280px; min-width: 0; display: flex; flex-direction: column; gap: 22px; position: sticky; top: 24px; }
.pad { padding: 22px 24px; }
.kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.req { display: flex; flex-wrap: wrap; gap: 14px; }
.hrow { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) 30px; gap: 8px; align-items: center; font-weight: 400; }
.icon { padding: 0; width: 30px; }
.presets { display: flex; flex-wrap: wrap; gap: 8px; }
.cfs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.note { margin: 0 0 10px; font-size: 13.5px; line-height: 1.55; }
.note:last-child { margin-bottom: 0; }
.savebar { position: sticky; bottom: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 22px; padding: 14px 0; background: linear-gradient(to bottom, rgba(255, 255, 255, 0.85), #fff 30%); border-top: 1px solid var(--line); }
.err-note { margin: 0; color: var(--fail); font-size: 13.5px; }
@media (max-width: 900px) {
  .side-col { position: static; }
}
@media (max-width: 720px) {
  .sect { padding: 20px 16px; }
  .pad { padding: 18px 16px; }
  .cf b { height: 44px; font-size: 15px; }
  .hrow { grid-template-columns: minmax(0, 1fr) 30px; }
  .hrow input:nth-child(2) { grid-row: 2; }
}
</style>
