<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import type { RunState } from "../store";

const props = defineProps<{ state: RunState | "run"; label?: string }>();

const text = computed(() => {
  if (props.label) return props.label;
  switch (props.state) {
    case "ok": return t("Success");
    case "fail": return t("Failed");
    case "paused": return t("Paused");
    case "run": return t("Running");
    default: return t("No runs yet");
  }
});
</script>

<template>
  <span class="pill" :class="state"><i></i>{{ text }}</span>
</template>
