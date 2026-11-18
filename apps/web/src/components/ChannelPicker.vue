<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { channelSummary, notifyName } from "../notify";
import { href } from "../router";
import { canManage, channels } from "../store";

const props = defineProps<{ projectId: string; loaded: boolean; error: string }>();
const selected = defineModel<string[]>({ required: true });

/** Channels of the whole workspace, and those of the job's project. */
const offered = computed(() =>
  channels.value
    .filter((channel) => channel.project_id === null || channel.project_id === props.projectId || selected.value.includes(channel.id))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

function toggle(id: string, on: boolean): void {
  selected.value = on ? [...selected.value, id] : selected.value.filter((item) => item !== id);
}
</script>

<template>
  <div>
    <p v-if="error" class="alert" role="alert" style="margin: 0 0 12px">{{ error }}</p>
    <p v-else-if="!loaded" class="muted" style="margin: 0 0 12px; font-size: 14px">{{ t("Loading…") }}</p>
    <template v-else>
      <label v-for="channel in offered" :key="channel.id" class="route pick">
        <input type="checkbox" :checked="selected.includes(channel.id)" @change="toggle(channel.id, ($event.target as HTMLInputElement).checked)" />
        <span style="min-width: 0; flex: 1">
          {{ channel.name }}
          <small class="faint"> · {{ notifyName(channel.type) }}</small>
          <small v-if="!channel.enabled" class="faint"> · {{ t("Off") }}</small>
          <small class="faint mono ellipsis" style="display: block; font-size: 12px">{{ channelSummary(channel.type, channel.config) }}</small>
        </span>
      </label>
      <p v-if="!offered.length" class="muted" style="margin: 0 0 12px; font-size: 14px">
        {{ canManage ? t("No alert channels yet. Add one to hear about failures.") : t("No alert channels yet. Ask an owner or admin to add one.") }}
      </p>
    </template>
    <a v-if="canManage" class="link" style="font-size: 14px" :href="href.channels">{{ t("Manage alert channels") }}</a>
  </div>
</template>

<style scoped>
.pick { cursor: pointer; }
.pick input { width: 16px; height: 16px; flex: none; accent-color: var(--accent); }
</style>
