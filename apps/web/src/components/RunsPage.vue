<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "../i18n";
import { duration, errorText, relative, shortDateTime } from "../format";
import { href } from "../router";
import { appendPage, fetchExecutions, jobsById } from "../store";
import type { Execution } from "../types";
import StatusPill from "./StatusPill.vue";

const PAGE = 100;
const runs = ref<Execution[]>([]);
const loaded = ref(false);
const more = ref(false);
const loading = ref(false);
const error = ref("");
const filter = ref<"all" | "fail">("all");

async function load(before?: number): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const rows = await fetchExecutions("/executions", PAGE, before);
    if (before) {
      const page = appendPage(runs.value, rows);
      runs.value = page.list;
      more.value = rows.length === PAGE && page.added > 0;
    } else {
      runs.value = rows;
      more.value = rows.length === PAGE;
    }
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

onMounted(() => load());

function loadOlder(): void {
  const last = runs.value[runs.value.length - 1];
  if (last) void load(last.started_at + 1);
}

const failed = computed(() => runs.value.filter((run) => !run.ok).length);
const shown = computed(() => (filter.value === "fail" ? runs.value.filter((run) => !run.ok) : runs.value));

function jobName(id: number): string {
  return jobsById.value.get(id)?.name ?? t("Deleted job #{id}", { id });
}
</script>

<template>
  <div class="hd">
    <div>
      <span class="eyebrow">{{ t("Activity") }}</span>
      <h1 class="serif" style="margin: 14px 0 0">{{ t("Runs") }}</h1>
      <p class="muted" style="margin: 12px 0 0; font-size: 15px; max-width: 520px">
        {{ t("Every run of every job, newest first, including the ones you started by hand.") }}
      </p>
    </div>
  </div>

  <p v-if="error" class="alert" role="alert">{{ error }} <button type="button" class="btn sm" style="margin-left: 8px" @click="load()">{{ t("Retry") }}</button></p>

  <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap">
    <div class="ftabs" role="tablist" :aria-label="t('Filter runs')">
      <button type="button" role="tab" class="ftab" :class="{ on: filter === 'all' }" :aria-selected="filter === 'all'" @click="filter = 'all'">{{ t("All") }} <em>{{ runs.length }}{{ more ? "+" : "" }}</em></button>
      <button type="button" role="tab" class="ftab" :class="{ on: filter === 'fail' }" :aria-selected="filter === 'fail'" @click="filter = 'fail'">{{ t("Failed") }} <em>{{ failed }}</em></button>
    </div>
    <span class="faint" style="font-size: 13px">{{ t("Counts cover the runs loaded below.") }}</span>
  </div>

  <div class="card runs-wrap">
    <div class="runs-table">
      <div class="rr runs th">
        <span>{{ t("Job") }}</span><span>{{ t("Started") }}</span><span>{{ t("Result") }}</span><span>{{ t("Code") }}</span><span>{{ t("Took") }}</span><span>{{ t("Detail") }}</span>
      </div>
      <a v-for="run in shown" :key="run.id" class="rr runs link-row" :href="jobsById.has(run.job_id) ? href.job(run.job_id) : undefined">
        <span class="ellipsis" style="font-weight: 500">{{ jobName(run.job_id) }}</span>
        <span class="mono" :title="relative(run.started_at)">{{ shortDateTime(run.started_at, true) }}</span>
        <span><StatusPill :state="run.ok ? 'ok' : 'fail'" /></span>
        <span class="mono">{{ run.status_code ?? "—" }}</span>
        <span class="mono">{{ duration(run.duration_ms) }}</span>
        <span class="muted ellipsis detail" style="font-size: 12.5px" :title="run.error ?? run.response_snippet ?? ''">{{ run.error ?? run.response_snippet ?? "" }}</span>
      </a>
      <p v-if="!loaded" class="muted empty">{{ t("Loading…") }}</p>
      <p v-else-if="!runs.length && !error" class="muted empty">
        {{ t("No runs yet. Jobs show up here after their first run.") }}
        <a class="link" :href="href.jobs">{{ t("Go to cron jobs") }}</a>
      </p>
      <p v-else-if="!shown.length" class="muted empty">{{ t("No failed runs among those loaded.") }}</p>
    </div>
  </div>

  <button v-if="more" type="button" class="btn" style="align-self: center" :disabled="loading" @click="loadOlder">
    {{ loading ? t("Loading…") : t("Load older runs") }}
  </button>
</template>

<style scoped>
.link-row { color: inherit; }
.link-row[href]:hover { background: var(--surface); }
.empty { margin: 0; padding: 24px 0 16px; font-size: 14px; }
.runs-wrap { overflow-x: auto; }
.runs-table { min-width: 680px; padding: 6px 22px 10px; }
/* Phones: job name on top, then time, result, code and duration, then the detail. */
@media (max-width: 720px) {
  .runs-table { min-width: 0; padding: 4px 16px 8px; }
  .runs-table .rr.th { display: none; }
  .runs-table .rr { grid-template-columns: minmax(0, 1fr) 84px 36px 56px; gap: 4px 10px; padding: 12px 0; font-size: 13px; }
  .runs-table .rr:nth-child(2) { border-top: 0; }
  .runs-table .rr > :first-child { grid-column: 1 / -1; }
  .runs-table .detail { grid-column: 1 / -1; }
  .runs-table .rr > .mono { white-space: nowrap; }
  .runs-table .detail:empty { display: none; }
}
</style>
