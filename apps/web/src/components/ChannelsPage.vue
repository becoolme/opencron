<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { api } from "../api";
import { errorText } from "../format";
import { t } from "../i18n";
import { channelSummary, configToDraft, draftToConfig, emptyNotifyDraft, NOTIFY_TYPES, notifyName, urlPlaceholder } from "../notify";
import { canManage, channels, loadChannels, projects, projectsById, workspace } from "../store";
import type { AlertChannel, NotifyDraft, NotifyType } from "../types";
import Icon from "./Icon.vue";

const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail" | "info"] }>();

const loaded = ref(false);
const error = ref("");

// the form: a new channel, or changes to `editing`
const open = ref(false);
const editing = ref<AlertChannel | null>(null);
const name = ref("");
const draft = ref<NotifyDraft>(emptyNotifyDraft());
const projectId = ref("");
const enabled = ref(true);
const autoEnable = ref(false);
const saving = ref(false);
const formError = ref("");
const busy = ref("");
const nameField = ref<HTMLInputElement | null>(null);

async function load(): Promise<void> {
  error.value = "";
  try {
    await loadChannels();
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

function focusForm(): void {
  void nextTick(() => nameField.value?.focus());
}

function startNew(type: NotifyType = "slack"): void {
  editing.value = null;
  name.value = "";
  draft.value = emptyNotifyDraft(type);
  projectId.value = "";
  enabled.value = true;
  autoEnable.value = channels.value.length === 0;
  formError.value = "";
  open.value = true;
  focusForm();
}

function startEdit(channel: AlertChannel): void {
  editing.value = channel;
  name.value = channel.name;
  draft.value = configToDraft(channel.type, channel.config);
  projectId.value = channel.project_id ?? "";
  enabled.value = channel.enabled;
  autoEnable.value = channel.auto_enable;
  formError.value = "";
  open.value = true;
  focusForm();
}

function pickType(type: NotifyType): void {
  if (editing.value) return;
  draft.value = emptyNotifyDraft(type);
  formError.value = "";
}

async function save(): Promise<void> {
  formError.value = "";
  if (!name.value.trim()) { formError.value = t("Enter a name."); return; }
  const result = draftToConfig(draft.value, !!editing.value);
  if (result.error !== undefined) { formError.value = result.error; return; }
  saving.value = true;
  try {
    const body = {
      name: name.value.trim(),
      config: result.config,
      project_id: projectId.value || null,
      enabled: enabled.value,
      auto_enable: autoEnable.value,
    };
    if (editing.value) {
      await api(`/channels/${editing.value.id}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      await api("/channels", { method: "POST", body: JSON.stringify({ ...body, type: draft.value.type }) });
    }
    emit("toast", editing.value ? t("Saved {name}.", { name: body.name }) : t("Added {name}.", { name: body.name }), "ok");
    open.value = false;
    await load();
  } catch (caught) {
    formError.value = errorText(caught);
  } finally {
    saving.value = false;
  }
}

async function test(channel: AlertChannel): Promise<void> {
  busy.value = `test-${channel.id}`;
  try {
    const result = await api<{ ok: boolean; error: string | null }>(`/channels/${channel.id}/test`, { method: "POST", body: "{}" });
    if (result.ok) emit("toast", t("Sent a test alert to {name}.", { name: channel.name }), "ok");
    else emit("toast", t("The test alert failed: {error}", { error: result.error ?? "" }), "fail");
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  } finally {
    busy.value = "";
  }
}

async function applyToAll(channel: AlertChannel): Promise<void> {
  const scopeText = channel.project_id ? projectsById.value.get(channel.project_id)?.name ?? "" : "";
  const question = scopeText
    ? t("Add {name} to every job in {project}?", { name: channel.name, project: scopeText })
    : t("Add {name} to every job in this workspace?", { name: channel.name });
  if (!confirm(question)) return;
  busy.value = `apply-${channel.id}`;
  try {
    const { added } = await api<{ added: number }>(`/channels/${channel.id}/apply-to-all`, { method: "POST", body: "{}" });
    emit("toast", t("Added {name} to {count} jobs.", { name: channel.name, count: String(added) }), "ok");
    await load();
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  } finally {
    busy.value = "";
  }
}

async function remove(channel: AlertChannel): Promise<void> {
  if (!confirm(t("Delete {name}? Jobs that use it will stop sending alerts there.", { name: channel.name }))) return;
  try {
    await api(`/channels/${channel.id}`, { method: "DELETE" });
    emit("toast", t("Deleted {name}.", { name: channel.name }), "ok");
    if (editing.value?.id === channel.id) open.value = false;
    await load();
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  }
}

function projectName(id: string | null): string {
  return id ? projectsById.value.get(id)?.name ?? "" : t("All projects");
}

const sorted = computed(() => [...channels.value].sort((a, b) => a.name.localeCompare(b.name)));
</script>

<template>
  <div class="hd">
    <div>
      <span class="eyebrow">{{ workspace?.name }}</span>
      <h1 class="serif">{{ t("Alert channels") }}</h1>
      <p class="muted" style="margin: 12px 0 0; font-size: 15px; max-width: 580px">
        {{ t("Where failed runs are reported. Set a channel up once, then pick it on each job. Default channels are added to new jobs.") }}
      </p>
    </div>
    <button v-if="canManage" type="button" class="btn primary" @click="startNew()"><Icon name="plus" />{{ t("Add channel") }}</button>
  </div>

  <p v-if="error" class="alert" role="alert">{{ error }} <button type="button" class="btn sm" style="margin-left: 8px" @click="load()">{{ t("Retry") }}</button></p>
  <p v-if="!canManage" class="muted" style="font-size: 14px">{{ t("Owners and admins add and change channels. You can pick them on your jobs.") }}</p>

  <form v-if="open" class="card" @submit.prevent="save" @keydown.esc="open = false">
    <div class="sect">
      <h3 class="serif">{{ editing ? t("Edit {name}", { name: editing.name }) : t("New alert channel") }}</h3>

      <div class="types" role="radiogroup" :aria-label="t('Channel')">
        <button
          v-for="type in NOTIFY_TYPES"
          :key="type"
          type="button"
          role="radio"
          class="preset"
          :class="{ on: draft.type === type }"
          :aria-checked="draft.type === type"
          :disabled="!!editing && draft.type !== type"
          @click="pickType(type)"
        >
          {{ notifyName(type) }}
        </button>
      </div>

      <div class="grid2">
        <label class="fld">
          <span>{{ t("Name") }}</span>
          <input ref="nameField" v-model="name" class="in" maxlength="60" :placeholder="t('For example: On-call Slack')" />
        </label>
        <label v-if="projects.length > 1" class="fld">
          <span>{{ t("Project") }}</span>
          <select v-model="projectId" class="in">
            <option value="">{{ t("All projects") }}</option>
            <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
          <small>{{ t("A channel of one project can only be used by that project's jobs.") }}</small>
        </label>
      </div>

      <template v-if="draft.type === 'telegram'">
        <div class="grid2">
          <label class="fld">
            <span>{{ t("Bot token") }}</span>
            <input v-model="draft.bot_token" class="in mono" autocomplete="off" spellcheck="false" placeholder="123456:ABC…" />
          </label>
          <label class="fld">
            <span>{{ t("Chat ID") }}</span>
            <input v-model="draft.chat_id" class="in mono" autocomplete="off" spellcheck="false" placeholder="-1001234567890" />
          </label>
        </div>
      </template>
      <template v-else>
        <label class="fld">
          <span>{{ t("Webhook URL") }}</span>
          <input v-model="draft.url" class="in mono" inputmode="url" autocomplete="off" spellcheck="false" :placeholder="urlPlaceholder(draft.type)" />
        </label>
        <label v-if="draft.type === 'lark' || draft.type === 'dingtalk'" class="fld">
          <span>{{ t("Signing secret") }} <small class="faint">{{ t("optional") }}</small></span>
          <input v-model="draft.sign_secret" class="in mono" autocomplete="off" spellcheck="false" />
          <small v-if="editing">{{ t("Clear it to stop signing alerts.") }}</small>
        </label>
        <label v-if="draft.type === 'http'" class="fld">
          <span>{{ t("Headers as JSON") }} <small class="faint">{{ t("optional") }}</small></span>
          <textarea v-model="draft.headers_text" class="in mono value" rows="2" spellcheck="false" placeholder='{"x-api-key": "…"}'></textarea>
          <small>{{ t("Receives a JSON POST describing the failed run.") }}</small>
        </label>
      </template>
      <p v-if="editing" class="faint" style="margin: 0; font-size: 13px">
        {{ t("Secrets are shown shortened. Leave them as they are to keep the saved values.") }}
      </p>

      <div class="toggles">
        <div class="tgl">
          <button type="button" role="switch" class="tg" :class="{ on: enabled }" :aria-checked="enabled" aria-labelledby="ch-enabled" @click="enabled = !enabled"></button>
          <span id="ch-enabled">{{ t("Sends alerts") }}</span>
        </div>
        <div class="tgl">
          <button type="button" role="switch" class="tg" :class="{ on: autoEnable }" :aria-checked="autoEnable" aria-labelledby="ch-default" @click="autoEnable = !autoEnable"></button>
          <span id="ch-default">{{ t("Add to new jobs by default") }}</span>
        </div>
      </div>

      <p v-if="formError" class="alert" role="alert" style="margin: 0">{{ formError }}</p>
      <div style="display: flex; gap: 8px">
        <button type="submit" class="btn primary" :disabled="saving">{{ saving ? t("Saving…") : t("Save") }}</button>
        <button type="button" class="btn" @click="open = false">{{ t("Cancel") }}</button>
      </div>
    </div>
  </form>

  <div class="card">
    <div class="list">
      <div v-for="channel in sorted" :key="channel.id" class="crow">
        <span class="ri"><Icon name="bell" /></span>
        <span class="main">
          <span class="title">
            <b>{{ channel.name }}</b>
            <span class="tag">{{ notifyName(channel.type) }}</span>
            <span v-if="channel.auto_enable" class="tag on">{{ t("Default") }}</span>
            <span v-if="!channel.enabled" class="tag off">{{ t("Off") }}</span>
          </span>
          <small class="faint mono ellipsis">{{ channelSummary(channel.type, channel.config) }}</small>
          <small class="muted">
            <template v-if="projects.length > 1">{{ projectName(channel.project_id) }} · </template>{{ t("Used by {count} jobs", { count: String(channel.job_count) }) }}
          </small>
        </span>
        <span v-if="canManage" class="acts">
          <button type="button" class="btn sm" :disabled="busy !== ''" @click="test(channel)">{{ busy === `test-${channel.id}` ? t("Sending…") : t("Test") }}</button>
          <button type="button" class="btn sm" :disabled="busy !== ''" @click="applyToAll(channel)">{{ t("Add to all jobs") }}</button>
          <button type="button" class="btn sm" @click="startEdit(channel)"><Icon name="edit" />{{ t("Edit") }}</button>
          <button type="button" class="btn sm danger" :aria-label="t('Delete {name}', { name: channel.name })" @click="remove(channel)"><Icon name="trash" /></button>
        </span>
      </div>
      <p v-if="!loaded" class="muted empty">{{ t("Loading…") }}</p>
      <p v-else-if="!channels.length && !error" class="muted empty">{{ t("No alert channels yet. Add one to hear about failures.") }}</p>
    </div>
  </div>
</template>

<style scoped>
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.types { display: flex; flex-wrap: wrap; gap: 6px; }
.value { height: auto; padding: 10px 14px; resize: vertical; line-height: 1.5; }
.toggles { display: flex; flex-wrap: wrap; gap: 12px 28px; }
.tgl { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.list { padding: 6px 22px 10px; }
.crow { display: flex; align-items: center; gap: 14px; min-height: 64px; padding: 12px 0; border-top: 1px solid var(--line); font-size: 14px; }
.crow:first-child { border-top: 0; }
.main { display: grid; gap: 2px; min-width: 0; flex: 1; }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.tag { font-size: 12px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--line-strong); color: var(--muted, #6b746e); }
.tag.on { border-color: var(--accent); color: var(--accent-ink); }
.tag.off { background: var(--line); }
.acts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.empty { margin: 0; padding: 24px 0 16px; font-size: 14px; }
@media (max-width: 720px) {
  .grid2 { grid-template-columns: 1fr; }
  .crow { flex-wrap: wrap; }
  .acts { justify-content: flex-start; width: 100%; }
}
</style>
