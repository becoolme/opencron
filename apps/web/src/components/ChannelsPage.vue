<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { errorText } from "../format";
import { t } from "../i18n";
import { channelSummary, notifyName } from "../notify";
import { canManage, channels, loadChannels, projects, projectsById, workspace } from "../store";
import type { AlertChannel } from "../types";
import ChannelForm from "./ChannelForm.vue";
import Icon from "./Icon.vue";

const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail" | "info"] }>();

const loaded = ref(false);
const error = ref("");

// the form: a new channel, or changes to `editing`; the key remounts it for each start
const open = ref(false);
const editing = ref<AlertChannel | null>(null);
const formKey = ref(0);
const busy = ref("");

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

function startNew(): void {
  editing.value = null;
  formKey.value++;
  open.value = true;
}

function startEdit(channel: AlertChannel): void {
  editing.value = channel;
  formKey.value++;
  open.value = true;
}

async function onSaved(channel: AlertChannel): Promise<void> {
  emit("toast", editing.value ? t("Saved {name}.", { name: channel.name }) : t("Added {name}.", { name: channel.name }), "ok");
  open.value = false;
  await load();
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

  <div v-if="open" class="card">
    <ChannelForm :key="formKey" :editing="editing" @saved="onSaved" @cancel="open = false" />
  </div>

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
  .crow { flex-wrap: wrap; }
  .acts { justify-content: flex-start; width: 100%; }
}
</style>
