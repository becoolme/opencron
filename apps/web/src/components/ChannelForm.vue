<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { api } from "../api";
import { errorText } from "../format";
import { t } from "../i18n";
import { configToDraft, draftToConfig, emptyNotifyDraft, NOTIFY_TYPES, notifyName, urlPlaceholder } from "../notify";
import { channels, projects } from "../store";
import type { AlertChannel, NotifyDraft, NotifyType } from "../types";

/**
 * Creates a channel, or changes `editing`. It is not a <form> of its own, so it can sit inside the job form: Enter in a
 * field saves the channel instead of submitting the job.
 */
const props = defineProps<{ editing: AlertChannel | null; projectId?: string; compact?: boolean }>();
const emit = defineEmits<{ saved: [channel: AlertChannel]; cancel: [] }>();

const name = ref(props.editing?.name ?? "");
const draft = ref<NotifyDraft>(props.editing ? configToDraft(props.editing.type, props.editing.config) : emptyNotifyDraft("slack"));
const projectId = ref(props.editing ? props.editing.project_id ?? "" : props.projectId ?? "");
const enabled = ref(props.editing?.enabled ?? true);
const autoEnable = ref(props.editing ? props.editing.auto_enable : channels.value.length === 0);
const saving = ref(false);
const formError = ref("");
const nameField = ref<HTMLInputElement | null>(null);
const uid = Math.random().toString(36).slice(2, 8);

onMounted(() => void nextTick(() => nameField.value?.focus()));

function pickType(type: NotifyType): void {
  if (props.editing) return;
  draft.value = emptyNotifyDraft(type);
  formError.value = "";
}

function onEnter(event: KeyboardEvent): void {
  if ((event.target as HTMLElement).tagName !== "INPUT") return;
  event.preventDefault();
  void save();
}

async function save(): Promise<void> {
  if (saving.value) return;
  formError.value = "";
  if (!name.value.trim()) { formError.value = t("Enter a name."); return; }
  const result = draftToConfig(draft.value, !!props.editing);
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
    const { channel } = props.editing
      ? await api<{ channel: AlertChannel }>(`/channels/${props.editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await api<{ channel: AlertChannel }>("/channels", { method: "POST", body: JSON.stringify({ ...body, type: draft.value.type }) });
    emit("saved", channel);
  } catch (caught) {
    formError.value = errorText(caught);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="sect" @keydown.enter="onEnter" @keydown.esc.stop="emit('cancel')">
    <h3 v-if="!compact" class="serif">{{ editing ? t("Edit {name}", { name: editing.name }) : t("New alert channel") }}</h3>
    <b v-else style="font-size: 14px">{{ t("New alert channel") }}</b>

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
        <button type="button" role="switch" class="tg" :class="{ on: enabled }" :aria-checked="enabled" :aria-labelledby="`ch-enabled-${uid}`" @click="enabled = !enabled"></button>
        <span :id="`ch-enabled-${uid}`">{{ t("Sends alerts") }}</span>
      </div>
      <div class="tgl">
        <button type="button" role="switch" class="tg" :class="{ on: autoEnable }" :aria-checked="autoEnable" :aria-labelledby="`ch-default-${uid}`" @click="autoEnable = !autoEnable"></button>
        <span :id="`ch-default-${uid}`">{{ t("Add to new jobs by default") }}</span>
      </div>
    </div>

    <p v-if="formError" class="alert" role="alert" style="margin: 0">{{ formError }}</p>
    <div style="display: flex; gap: 8px">
      <button type="button" class="btn primary" :class="{ sm: compact }" :disabled="saving" @click="save">{{ saving ? t("Saving…") : t("Save") }}</button>
      <button type="button" class="btn" :class="{ sm: compact }" @click="emit('cancel')">{{ t("Cancel") }}</button>
    </div>
  </div>
</template>

<style scoped>
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.types { display: flex; flex-wrap: wrap; gap: 6px; }
.value { height: auto; padding: 10px 14px; resize: vertical; line-height: 1.5; }
.toggles { display: flex; flex-wrap: wrap; gap: 12px 28px; }
.tgl { display: flex; align-items: center; gap: 10px; font-size: 14px; }
@media (max-width: 720px) {
  .grid2 { grid-template-columns: 1fr; }
}
</style>
