<script setup lang="ts">
import { nextTick, ref } from "vue";
import { t } from "../i18n";
import { draftToTarget, emptyNotifyDraft, NOTIFY_TYPES, notifyName, targetSummary, urlPlaceholder } from "../notify";
import type { NotifyDraft, NotifyTarget, NotifyType } from "../types";
import Icon from "./Icon.vue";

const targets = defineModel<NotifyTarget[]>({ required: true });

const draft = ref<NotifyDraft | null>(null);
const error = ref("");
const firstField = ref<HTMLInputElement | null>(null);
const addButton = ref<HTMLButtonElement | null>(null);

/** The draft panel or a removed row takes focus with it; hand it back to the add button. */
function restoreFocus(): void {
  void nextTick(() => addButton.value?.focus());
}

async function start(type: NotifyType = "slack"): Promise<void> {
  draft.value = emptyNotifyDraft(type);
  error.value = "";
  await nextTick();
  firstField.value?.focus();
}

function pick(type: NotifyType): void {
  if (!draft.value) return;
  draft.value = { ...emptyNotifyDraft(type) };
  error.value = "";
  void nextTick(() => firstField.value?.focus());
}

function add(): void {
  if (!draft.value) return;
  const result = draftToTarget(draft.value);
  if (result.error !== undefined) {
    error.value = result.error;
    return;
  }
  targets.value = [...targets.value, result.target];
  draft.value = null;
  error.value = "";
  restoreFocus();
}

/** Enter in a single-line field adds the channel instead of submitting the job form. */
function onEnter(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement) {
    event.preventDefault();
    add();
  }
}

function cancel(): void {
  draft.value = null;
  error.value = "";
  restoreFocus();
}

function remove(index: number): void {
  targets.value = targets.value.filter((_, i) => i !== index);
  if (!draft.value) restoreFocus();
}
</script>

<template>
  <div>
    <div v-for="(target, index) in targets" :key="index" class="route">
      <span class="ri"><Icon name="bell" /></span>
      <span style="min-width: 0; flex: 1">
        {{ notifyName(target.type) }}
        <small v-if="'sign_secret' in target && target.sign_secret" class="faint"> · {{ t("signed", "已签名") }}</small>
        <small class="faint mono ellipsis" style="display: block; font-size: 12px">{{ targetSummary(target) }}</small>
      </span>
      <button type="button" class="btn sm icon" :aria-label="t(`Remove ${notifyName(target.type)}`, `移除${notifyName(target.type)}`)" @click="remove(index)">
        <Icon name="x" :size="14" />
      </button>
    </div>
    <p v-if="!targets.length && !draft" class="muted" style="margin: 0 0 12px; font-size: 14px">
      {{ t("No alert channels yet. Add one to hear about failures.", "还没有告警渠道。添加一个，任务失败时会通知你。") }}
    </p>

    <div v-if="draft" class="draft" role="group" :aria-label="t('New alert channel', '新告警渠道')" @keydown.esc.stop="cancel" @keydown.enter="onEnter" @input="error = ''">
      <div class="types" role="radiogroup" :aria-label="t('Channel', '渠道')">
        <button
          v-for="type in NOTIFY_TYPES"
          :key="type"
          type="button"
          role="radio"
          class="preset"
          :class="{ on: draft.type === type }"
          :aria-checked="draft.type === type"
          @click="pick(type)"
        >
          {{ notifyName(type) }}
        </button>
      </div>

      <template v-if="draft.type === 'telegram'">
        <label class="fld">
          <span>Bot token</span>
          <input ref="firstField" v-model="draft.bot_token" class="in mono" autocomplete="off" spellcheck="false" placeholder="123456:ABC…" />
        </label>
        <label class="fld">
          <span>Chat ID</span>
          <input v-model="draft.chat_id" class="in mono" autocomplete="off" spellcheck="false" placeholder="-1001234567890" />
        </label>
      </template>
      <template v-else>
        <label class="fld">
          <span>{{ t("Webhook URL", "Webhook 地址") }}</span>
          <input ref="firstField" v-model="draft.url" class="in mono" type="url" inputmode="url" autocomplete="off" spellcheck="false" :placeholder="urlPlaceholder(draft.type)" />
        </label>
        <label v-if="draft.type === 'lark' || draft.type === 'dingtalk'" class="fld">
          <span>{{ t("Signing secret", "签名密钥") }} <small class="faint">{{ t("optional", "可选") }}</small></span>
          <input v-model="draft.sign_secret" class="in mono" autocomplete="off" spellcheck="false" />
        </label>
        <label v-if="draft.type === 'http'" class="fld">
          <span>{{ t("Headers as JSON", "请求头（JSON）") }} <small class="faint">{{ t("optional", "可选") }}</small></span>
          <textarea v-model="draft.headers_text" class="in mono" rows="2" spellcheck="false" placeholder='{"x-api-key": "…"}'></textarea>
          <small>{{ t("Receives a JSON POST describing the failed run.", "收到一条描述失败运行的 JSON POST。") }}</small>
        </label>
      </template>

      <p v-if="error" class="fld" style="margin: 0"><small class="err" role="alert">{{ error }}</small></p>
      <div style="display: flex; gap: 8px">
        <button type="button" class="btn sm primary" @click="add">{{ t("Add channel", "添加渠道") }}</button>
        <button type="button" class="btn sm" @click="cancel">{{ t("Cancel", "取消") }}</button>
      </div>
    </div>

    <button v-else ref="addButton" type="button" class="btn sm" style="margin-top: 4px" @click="start()">
      <Icon name="plus" :size="14" />{{ t("Add alert channel", "添加告警渠道") }}
    </button>
  </div>
</template>

<style scoped>
.draft { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); margin-top: 8px; }
.types { display: flex; flex-wrap: wrap; gap: 6px; }
.icon { padding: 0; width: 30px; flex: none; }
</style>
