<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import type { RunState } from "../store";

const props = defineProps<{ state: RunState | "run"; label?: string }>();

const text = computed(() => {
  if (props.label) return props.label;
  switch (props.state) {
    case "ok": return t("Success", "成功");
    case "fail": return t("Failed", "失败");
    case "paused": return t("Paused", "已暂停");
    case "run": return t("Running", "运行中");
    default: return t("No runs yet", "尚未运行");
  }
});
</script>

<template>
  <span class="pill" :class="state"><i></i>{{ text }}</span>
</template>
