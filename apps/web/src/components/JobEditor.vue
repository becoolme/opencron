<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { api } from "../api";
import { t } from "../i18n";
import { clock, dayLabel, describeCron, errorText, nextRuns, relative } from "../format";
import { emptyForm, formToPayload, isTemplate, jobToForm, methodHasBody, METHODS, TEMPLATES, validateForm, type FormErrors } from "../job-form";
import { go, guardLeave, href } from "../router";
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
  // Labels are dictionary keys; t() is applied in the template.
  { cron: "*/5 * * * *", label: "Every 5 min" },
  { cron: "0 * * * *", label: "Hourly" },
  { cron: "0 3 * * *", label: "Daily 03:00" },
  { cron: "30 9 * * 1-5", label: "Weekdays 09:30" },
  { cron: "15 2 * * 0", label: "Sundays 02:15" },
  { cron: "0 8 1 * *", label: "Monthly" },
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
  const labels = [t("minute"), t("hour"), t("day"), t("month"), t("weekday")];
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
    emit("toast", editing.value ? t("Changes saved") : t("Job created"), "ok");
    go(href.job(id!));
  } catch (caught) {
    saveError.value = errorText(caught);
  } finally {
    saving.value = false;
  }
}

function cancel(): void {
  if (dirty.value && !confirm(t("Discard your changes?"))) return;
  initial.value = JSON.stringify(form.value);
  go(editing.value ? href.job(props.id!) : href.jobs);
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value && !saving.value) event.preventDefault();
}
window.addEventListener("beforeunload", onBeforeUnload);
const releaseGuard = guardLeave(() => !dirty.value || saving.value || confirm(t("Discard your changes?")));
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  releaseGuard();
});
</script>

<template>
  <div v-if="editing && !source" class="card" style="padding: 40px; text-align: center">
    <p class="serif" style="font-size: 24px; margin: 0">{{ t("Job not found") }}</p>
    <p class="muted"><a class="link" :href="href.jobs">{{ t("Back to cron jobs") }}</a></p>
  </div>

  <form v-else class="editor" novalidate @submit.prevent="save">
    <div class="hd" style="padding-bottom: 28px">
      <div>
        <span class="eyebrow">{{ editing ? t("Edit job") : t("New job") }}</span>
        <h1 class="serif" style="margin: 14px 0 0; overflow-wrap: anywhere">{{ editing ? source?.name : t("Schedule something") }}</h1>
      </div>
    </div>

    <div class="cols">
      <div class="card main-col">
        <section class="sect">
          <h3 class="serif">{{ t("What runs") }}</h3>
          <div class="kinds" role="radiogroup" :aria-label="t('Job type')">
            <button type="button" role="radio" class="kind" :class="{ on: form.type === 'url' }" :aria-checked="form.type === 'url'" :disabled="editing" @click="setType('url')">
              <span style="display: flex; gap: 8px; align-items: center; font-weight: 500"><Icon name="globe" />{{ t("Call a URL") }}</span>
              <small class="muted">{{ t("Send an HTTP request on schedule. 2xx counts as success.") }}</small>
            </button>
            <button type="button" role="radio" class="kind" :class="{ on: form.type === 'script' }" :aria-checked="form.type === 'script'" :disabled="editing" @click="setType('script')">
              <span style="display: flex; gap: 8px; align-items: center; font-weight: 500"><Icon name="code" />{{ t("Run a script") }}</span>
              <small class="muted">{{ onCloudflare ? t("JavaScript in an isolated Worker.") : t("JavaScript, Python or Go in a sandbox.") }}</small>
            </button>
          </div>
          <small v-if="editing" class="faint" style="margin-top: -8px">{{ t("The type can't change after a job is created.") }}</small>

          <label class="fld">
            <span>{{ t("Name") }}</span>
            <input id="f-name" v-model="form.name" class="in" :class="{ bad: errors.name }" maxlength="200" :placeholder="t('Nightly backup')" :aria-invalid="!!errors.name" :aria-describedby="errors.name ? 'e-name' : undefined" />
            <small v-if="errors.name" id="e-name" class="err">{{ errors.name }}</small>
          </label>
        </section>

        <section v-if="form.type === 'url'" class="sect">
          <h3 class="serif">{{ t("Request") }}</h3>
          <div class="req">
            <label class="fld" style="flex: 0 0 120px">
              <span>{{ t("Method") }}</span>
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
            <span>{{ t("Headers") }} <small class="faint">{{ t("optional") }}</small></span>
            <div v-for="(row, index) in form.headers" :key="index" class="hrow">
              <input :id="index === 0 ? 'f-headers' : undefined" v-model="row.key" class="in mono" :class="{ bad: errors.headers }" spellcheck="false" autocomplete="off" :placeholder="t('Name')" :aria-label="t('Header {n} name', { n: index + 1 })" />
              <input v-model="row.value" class="in mono" spellcheck="false" autocomplete="off" :placeholder="t('Value')" :aria-label="t('Header {n} value', { n: index + 1 })" />
              <button type="button" class="btn sm icon" :aria-label="t('Remove header {n}', { n: index + 1 })" @click="removeHeader(index)"><Icon name="x" :size="14" /></button>
            </div>
            <small v-if="errors.headers" id="e-headers" class="err" role="alert">{{ errors.headers }}</small>
            <button type="button" class="btn sm" style="width: max-content" @click="addHeader"><Icon name="plus" :size="14" />{{ t("Add header") }}</button>
          </div>

          <label v-if="methodHasBody(form.method)" class="fld">
            <span>{{ t("Body") }} <small class="faint">{{ t("optional") }}</small></span>
            <textarea v-model="form.body" class="in mono" rows="4" spellcheck="false" placeholder='{"task": "cleanup"}'></textarea>
            <small>{{ t("Sent as is. Add a Content-Type header if the endpoint needs one.") }}</small>
          </label>
        </section>

        <section v-else class="sect">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap">
            <h3 class="serif">{{ t("Script") }}</h3>
            <div v-if="offeredRuntimes.length > 1" class="seg" role="radiogroup" :aria-label="t('Language')">
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
              <span style="color: #8b948e">{{ form.runtime === "javascript" ? t("2xx response = success") : t("exit 0 = success") }}</span>
            </div>
            <CodeEditor v-model="form.script" :language="form.runtime" :label="t('Script source')" />
          </div>
          <p v-if="errors.script" id="e-script" class="err-note" role="alert">{{ errors.script }}</p>
          <p v-if="!runtimes.includes(form.runtime)" class="alert" style="margin: 0">
            {{ t("This deployment can't run {runtime}. Switch to JavaScript or run OpenCron with Docker.", { runtime: RUNTIME_LABEL[form.runtime] }) }}
          </p>
        </section>

        <section class="sect">
          <h3 class="serif">{{ t("Schedule") }}</h3>
          <div class="presets" role="radiogroup" :aria-label="t('Common schedules')">
            <button v-for="preset in PRESETS" :key="preset.cron" type="button" role="radio" class="preset" :class="{ on: presetOn === preset.cron }" :aria-checked="presetOn === preset.cron" @click="pickPreset(preset.cron)">
              {{ t(preset.label) }}
            </button>
            <button type="button" role="radio" class="preset" :class="{ on: presetOn === 'custom' }" :aria-checked="presetOn === 'custom'" @click="pickPreset(null)">{{ t("Custom") }}</button>
          </div>
          <div class="cfs" aria-hidden="true">
            <div v-for="field in cronFields" :key="field.label" class="cf"><b>{{ field.value || "·" }}</b><span>{{ field.label }}</span></div>
          </div>
          <label class="fld">
            <span>{{ t("Cron expression") }} <small class="faint">UTC</small></span>
            <input id="f-cron" ref="cronInput" v-model="form.cron" class="in mono" :class="{ bad: errors.cron }" spellcheck="false" autocomplete="off" placeholder="*/5 * * * *" :aria-invalid="!!errors.cron" :aria-describedby="errors.cron ? 'e-cron' : undefined" />
            <small v-if="errors.cron" id="e-cron" class="err">{{ errors.cron }}</small>
            <small v-else-if="cronText">{{ cronText }}</small>
            <small v-else-if="!cronLive" class="err">{{ t("Not a valid cron expression yet.") }}</small>
          </label>
        </section>

        <section class="sect">
          <h3 class="serif">{{ t("Run settings") }}</h3>
          <div class="req">
            <label class="fld" style="flex: 0 1 200px">
              <span>{{ t("Timeout") }}</span>
              <select id="f-timeout_ms" v-model.number="form.timeout_ms" class="in" :aria-invalid="!!errors.timeout_ms" :aria-describedby="errors.timeout_ms ? 'e-timeout_ms' : undefined">
                <option v-for="ms in timeoutOptions" :key="ms" :value="ms">{{ ms / 1000 }} {{ t("seconds") }}</option>
              </select>
              <small v-if="errors.timeout_ms" id="e-timeout_ms" class="err">{{ errors.timeout_ms }}</small>
            </label>
            <div class="fld" style="flex: 1 1 240px">
              <span id="enabled-label">{{ t("Status") }}</span>
              <div style="display: flex; align-items: center; gap: 10px; height: 44px">
                <button type="button" role="switch" class="tg" :class="{ on: form.enabled }" :aria-checked="form.enabled" aria-labelledby="enabled-label" @click="form.enabled = !form.enabled"></button>
                <span style="font-weight: 400">{{ form.enabled ? t("Runs on schedule") : t("Paused, won't run") }}</span>
              </div>
            </div>
          </div>
        </section>

        <section class="sect">
          <div>
            <h3 class="serif">{{ t("Alerts") }}</h3>
            <p class="muted" style="margin: 6px 0 0; font-size: 14px">{{ t("Notified when a run fails.") }}</p>
          </div>
          <NotifyEditor v-model="form.notify_targets" />
        </section>
      </div>

      <aside class="side-col">
        <section class="card pad">
          <h3 class="serif" style="margin-bottom: 14px">{{ t("Next 5 runs") }}</h3>
          <div v-if="upcoming.length">
            <div v-for="(at, i) in upcoming" :key="at" class="nr">
              <span class="muted">{{ dayLabel(at) }}<template v-if="i === 0"> · {{ relative(at) }}</template></span>
              <b class="mono" style="font-weight: 500; font-size: 13.5px">{{ clock(at) }}</b>
            </div>
            <p class="faint" style="margin: 12px 0 0; font-size: 12.5px">{{ t("Shown in your time zone.") }}</p>
          </div>
          <p v-else class="muted" style="margin: 0; font-size: 14px">{{ t("Enter a valid cron expression to preview.") }}</p>
        </section>

        <section v-if="form.type === 'script'" class="card pad">
          <h3 class="serif" style="margin-bottom: 10px">{{ t("Where it runs") }}</h3>
          <template v-if="form.runtime === 'javascript' && onCloudflare">
            <p class="muted note">{{ t("Each run gets its own Worker isolate without network access. Your fetch handler receives the job ID, name and scheduled time.") }}</p>
            <p class="muted note">{{ t("env.KV and env.D1 keep data for this job between runs.") }}</p>
          </template>
          <template v-else>
            <p class="muted note">{{ t("Each run starts a fresh container with no network, a read-only file system and a non-root user.") }}</p>
            <p class="muted note">{{ t("The run context is JSON in OPENCRON_CONTEXT. Stdout is kept with the run; stderr becomes the error.") }}</p>
            <p v-if="form.runtime === 'go'" class="muted note">{{ t("Go compiles on every run, so allow time for the build.") }}</p>
          </template>
        </section>
      </aside>
    </div>

    <div class="savebar">
      <p v-if="saveError" class="alert" role="alert" style="margin: 0; flex: 1 1 100%">{{ saveError }}</p>
      <p v-else-if="submitted && Object.keys(errors).length" class="err-note" role="status">{{ t("Fix the highlighted fields to save.") }}</p>
      <span v-else class="faint" style="font-size: 13px">{{ dirty ? t("Unsaved changes") : "" }}</span>
      <div style="display: flex; gap: 10px; margin-left: auto">
        <button type="button" class="btn" @click="cancel">{{ t("Cancel") }}</button>
        <button type="submit" class="btn primary" :disabled="saving">{{ saving ? t("Saving…") : editing ? t("Save changes") : t("Create job") }}</button>
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
