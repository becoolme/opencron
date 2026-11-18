<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../i18n";
import { channelSummary, notifyName } from "../notify";
import { href } from "../router";
import { canManage, channels, loadChannels } from "../store";
import type { AlertChannel } from "../types";
import ChannelForm from "./ChannelForm.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ projectId: string; loaded: boolean; error: string }>();
const selected = defineModel<string[]>({ required: true });

/** Channels of the whole workspace, and those of the job's project. */
const offered = computed(() =>
  channels.value
    .filter((channel) => channel.project_id === null || channel.project_id === props.projectId || selected.value.includes(channel.id))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

const creating = ref(false);

/** A channel made here is ticked on the job at once. */
async function onCreated(channel: AlertChannel): Promise<void> {
  creating.value = false;
  if (!selected.value.includes(channel.id)) selected.value = [...selected.value, channel.id];
  await loadChannels().catch(() => undefined);
}

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
    <div v-if="creating" class="create">
      <ChannelForm :editing="null" compact @saved="onCreated" @cancel="creating = false" />
    </div>
    <div v-if="canManage" class="foot">
      <button v-if="!creating && loaded && !error" type="button" class="btn sm" @click="creating = true"><Icon name="plus" />{{ t("Add channel") }}</button>
      <a class="link" style="font-size: 14px" :href="href.channels">{{ t("Manage alert channels") }}</a>
    </div>
  </div>
</template>

<style scoped>
.pick { cursor: pointer; }
.create { margin: 0 0 12px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; }
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.pick input { width: 16px; height: 16px; flex: none; accent-color: var(--accent); }
</style>
