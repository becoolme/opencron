<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "../i18n";
import { clock, dayLabel, describeCron, duration, relative } from "../format";
import { href } from "../router";
import { jobState, jobs, loaded, recent, recentByJob, RECENT_LIMIT } from "../store";
import { RUNTIME_LABEL, type Job } from "../types";
import HeaderArt from "./HeaderArt.vue";
import Icon from "./Icon.vue";
import StatusPill from "./StatusPill.vue";

type Filter = "all" | "failed" | "paused";
const filter = ref<Filter>("all");
const query = ref("");
const search = ref<HTMLInputElement | null>(null);
const now = ref(Date.now());

const failedJobs = computed(() => jobs.value.filter((job) => jobState(job) === "fail"));
const pausedJobs = computed(() => jobs.value.filter((job) => !job.enabled));

const visible = computed(() => {
  const base = filter.value === "failed" ? failedJobs.value : filter.value === "paused" ? pausedJobs.value : jobs.value;
  const q = query.value.trim().toLowerCase();
  if (!q) return base;
  return base.filter((job) => job.name.toLowerCase().includes(q) || (job.url ?? "").toLowerCase().includes(q));
});

const day = computed(() => {
  const since = Math.floor(now.value / 1000) - 86400;
  const runs = recent.value.filter((e) => e.started_at >= since);
  const failed = runs.filter((e) => !e.ok).length;
  const capped = recent.value.length >= RECENT_LIMIT && runs.length === recent.value.length;
  const avg = runs.length ? runs.reduce((sum, e) => sum + e.duration_ms, 0) / runs.length : null;
  return { count: runs.length, failed, capped, avg, rate: runs.length ? ((runs.length - failed) / runs.length) * 100 : null };
});

const nextRun = computed(() => {
  const times = jobs.value.filter((job) => job.enabled).map((job) => job.next_run_at);
  return times.length ? Math.min(...times) : null;
});

function bars(job: Job): string[] {
  const runs = (recentByJob.value.get(job.id) ?? []).slice(-20).map((e) => (e.ok ? "" : "f"));
  return [...Array(20 - runs.length).fill("n"), ...runs];
}

function lastDuration(job: Job): string {
  const runs = recentByJob.value.get(job.id);
  return runs?.length ? duration(runs[runs.length - 1].duration_ms) : "—";
}

function target(job: Job): string {
  if (job.type === "url") return job.url ?? "";
  const runtime = RUNTIME_LABEL[job.runtime];
  return `${runtime} · ${t("script", "脚本")} v${job.script_version}`;
}

function onKey(event: KeyboardEvent): void {
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && !(event.target as HTMLElement)?.isContentEditable) {
    event.preventDefault();
    search.value?.focus();
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  window.addEventListener("keydown", onKey);
  timer = setInterval(() => (now.value = Date.now()), 15_000);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  clearInterval(timer);
});
</script>

<template>
  <div class="hd">
    <div style="max-width: 560px">
      <span class="eyebrow">{{ t(`${jobs.length} jobs · cron in UTC`, `${jobs.length} 个任务 · cron 按 UTC`) }}</span>
      <h1 class="serif">{{ t("Cron jobs", "定时任务") }}</h1>
      <p class="muted" style="margin: 8px 0 18px; font-size: 15px">
        {{ t(
          "Call an HTTP endpoint or run a script on a schedule. Failed runs notify the channels you set on each job.",
          "按计划调用 HTTP 端点或运行脚本。运行失败时，会通知任务上设置的告警渠道。",
        ) }}
      </p>
      <a class="btn primary" :href="href.newJob"><Icon name="plus" />{{ t("New job", "新建任务") }}</a>
    </div>
    <HeaderArt :failed="failedJobs.length > 0" />
  </div>

  <div v-if="failedJobs.length" class="banner" role="status">
    <span class="dot" aria-hidden="true"></span>
    <div style="flex: 1; min-width: 220px; font-size: 14.5px">
      <b style="font-weight: 600">
        {{ failedJobs.length === 1
          ? t(`${failedJobs[0].name} failed on its last run`, `${failedJobs[0].name} 上次运行失败`)
          : t(`${failedJobs.length} jobs failed on their last run`, `${failedJobs.length} 个任务上次运行失败`) }}
      </b>
      <span class="muted"> · {{ t("last run", "最近一次") }} {{ relative(failedJobs[0].last_run_at, now) }}</span>
    </div>
    <a v-if="failedJobs.length === 1" class="btn sm" :href="href.job(failedJobs[0].id)">{{ t("Open job", "查看任务") }}</a>
    <button v-else type="button" class="btn sm" @click="filter = 'failed'">{{ t("Show failed", "只看失败") }}</button>
  </div>

  <div class="stats">
    <div class="card stat">
      <div class="muted" style="font-size: 13px">{{ t("Enabled jobs", "启用中的任务") }}</div>
      <div class="v">{{ jobs.length - pausedJobs.length }}<small>/ {{ jobs.length }}</small></div>
      <div class="s">{{ t(`${pausedJobs.length} paused`, `${pausedJobs.length} 个已暂停`) }}</div>
    </div>
    <div class="card stat">
      <div class="muted" style="font-size: 13px">{{ t("Runs · 24h", "近 24 小时运行") }}</div>
      <div class="v">{{ day.count.toLocaleString() }}<small v-if="day.capped">+</small></div>
      <div class="s" :style="nextRun ? 'color: var(--ok)' : ''">
        {{ nextRun ? t(`Next: ${relative(nextRun, now)}`, `下一次：${relative(nextRun, now)}`) : t("Nothing scheduled", "暂无计划") }}
      </div>
    </div>
    <div class="card stat">
      <div class="muted" style="font-size: 13px">{{ t("Success rate · 24h", "成功率 · 24h") }}</div>
      <div class="v">{{ day.rate == null ? "—" : day.rate.toFixed(day.rate === 100 ? 0 : 1) }}<small v-if="day.rate != null">%</small></div>
      <div class="s" :style="day.failed ? 'color: var(--fail)' : ''">{{ t(`${day.failed} failed`, `${day.failed} 次失败`) }}</div>
    </div>
    <div class="card stat">
      <div class="muted" style="font-size: 13px">{{ t("Average duration · 24h", "平均耗时 · 24h") }}</div>
      <div class="v">{{ duration(day.avg) }}</div>
      <div class="s">{{ day.capped ? t(`From the latest ${RECENT_LIMIT} runs`, `基于最近 ${RECENT_LIMIT} 次运行`) : t("All runs in 24 hours", "24 小时内全部运行") }}</div>
    </div>
  </div>

  <div class="toolbar">
    <div class="ftabs" role="tablist">
      <button type="button" role="tab" class="ftab" :class="{ on: filter === 'all' }" :aria-selected="filter === 'all'" @click="filter = 'all'">
        {{ t("All", "全部") }}<em>{{ jobs.length }}</em>
      </button>
      <button type="button" role="tab" class="ftab" :class="{ on: filter === 'failed' }" :aria-selected="filter === 'failed'" @click="filter = 'failed'">
        {{ t("Failed", "失败") }}<em>{{ failedJobs.length }}</em>
      </button>
      <button type="button" role="tab" class="ftab" :class="{ on: filter === 'paused' }" :aria-selected="filter === 'paused'" @click="filter = 'paused'">
        {{ t("Paused", "已暂停") }}<em>{{ pausedJobs.length }}</em>
      </button>
    </div>
    <label class="search">
      <Icon name="search" />
      <input ref="search" v-model="query" type="search" :aria-label="t('Search jobs', '搜索任务')" :placeholder="t('Search by name or URL', '搜索任务名称或 URL')" />
      <kbd class="mono key" aria-hidden="true">/</kbd>
    </label>
  </div>

  <div class="card jobs-wrap">
    <div class="jobs-table">
      <div class="row th" style="min-height: 44px; border-top: 0; background: var(--surface); border-radius: 15px 15px 0 0">
        <span>{{ t("Job", "任务") }}</span><span>{{ t("Schedule", "计划") }}</span><span>{{ t("Next run", "下次运行") }}</span>
        <span>{{ t("Last 20", "最近 20 次") }}</span><span>{{ t("Last result", "上次结果") }}</span><span style="text-align: right">{{ t("Took", "耗时") }}</span>
      </div>
      <a v-for="job in visible" :key="job.id" class="row" :href="href.job(job.id)">
        <span style="display: flex; align-items: center; gap: 12px; min-width: 0">
          <span class="method">{{ job.type === "url" ? job.method : (job.runtime === "python" ? "PY" : job.runtime === "go" ? "GO" : "JS") }}</span>
          <span style="min-width: 0">
            <b class="ellipsis" style="display: block; font-weight: 500; font-size: 15px; line-height: 1.3">{{ job.name }}</b>
            <small class="mono faint ellipsis" style="display: block; font-size: 12.5px">{{ target(job) }}</small>
          </span>
        </span>
        <span style="display: grid; gap: 3px; justify-items: start; min-width: 0">
          <span class="chip">{{ job.cron }}</span>
          <small v-if="describeCron(job.cron)" class="faint ellipsis" style="font-size: 12.5px; max-width: 100%">{{ describeCron(job.cron) }}</small>
        </span>
        <span style="display: grid; line-height: 1.3">
          <template v-if="job.enabled">
            <span class="mono" style="font-size: 13.5px">{{ relative(job.next_run_at, now) }}</span>
            <small class="faint" style="font-size: 12px">{{ dayLabel(job.next_run_at) }} {{ clock(job.next_run_at) }}</small>
          </template>
          <span v-else class="faint" style="font-size: 13.5px">{{ t("Paused", "已暂停") }}</span>
        </span>
        <span class="bars" role="img" :aria-label="t('Last 20 runs', '最近 20 次运行')">
          <i v-for="(c, i) in bars(job)" :key="i" :class="c"></i>
        </span>
        <span><StatusPill :state="jobState(job)" /></span>
        <span class="mono" style="font-size: 13.5px; text-align: right">{{ lastDuration(job) }}</span>
      </a>

      <div v-if="loaded && jobs.length === 0" class="empty">
        <p class="serif" style="font-size: 24px; margin: 0">{{ t("No jobs yet", "还没有任务") }}</p>
        <p class="muted" style="margin: 6px 0 16px">{{ t("Create one to call a URL or run a script on a schedule.", "新建一个任务，按计划调用 URL 或运行脚本。") }}</p>
        <a class="btn primary" :href="href.newJob"><Icon name="plus" />{{ t("New job", "新建任务") }}</a>
      </div>
      <div v-else-if="loaded && visible.length === 0" class="empty muted">
        {{ t("No jobs match.", "没有匹配的任务。") }}
        <button type="button" class="link" style="background: none; border: 0" @click="query = ''; filter = 'all'">{{ t("Clear filters", "清除筛选") }}</button>
      </div>
      <div v-else-if="!loaded" class="empty muted">{{ t("Loading…", "加载中…") }}</div>

      <div v-if="jobs.length" class="foot faint">
        <span>{{ t(`Showing ${visible.length} of ${jobs.length} jobs`, `显示 ${visible.length} / ${jobs.length} 个任务`) }}</span>
        <span class="mono legend"><i class="ok"></i>{{ t("success", "成功") }} <i class="f"></i>{{ t("failed", "失败") }} <i class="n"></i>{{ t("no run", "无记录") }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.banner { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-radius: 16px; border: 1px solid #f2cfcf; flex-wrap: wrap; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--bar-fail); box-shadow: 0 0 0 4px #fbeaea; flex: none; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.search { display: flex; align-items: center; gap: 9px; width: 300px; max-width: 100%; height: 38px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; color: var(--hint); }
.search:focus-within { border-color: var(--accent); outline: 2px solid #c9d3f7; }
.search input { flex: 1; min-width: 0; border: 0; background: none; outline: 0; font: 14px var(--sans); color: var(--ink); }
.key { font-size: 11.5px; border: 1px solid var(--line-strong); border-radius: 5px; padding: 1px 6px; }
.empty { padding: 40px 22px; text-align: center; border-top: 1px solid var(--line); }
.foot { padding: 14px 22px; border-top: 1px solid var(--line); font-size: 13px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.legend { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; background: var(--bar-ok); margin-left: 6px; }
.legend i.f { background: var(--bar-fail); }
.legend i.n { background: var(--line-strong); }
.jobs-wrap { overflow-x: auto; }
.jobs-table { min-width: 860px; }
@media (hover: none) {
  .key { display: none; }
}
@media (max-width: 720px) {
  .search { width: 100%; }
  .toolbar .ftabs { overflow-x: auto; max-width: 100%; }
}
/* Phones and tablets: each job becomes a two-column card instead of a table that scrolls sideways. */
@media (max-width: 900px) {
  .jobs-wrap { overflow: visible; }
  .jobs-table { min-width: 0; }
  .row.th { display: none; }
  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "job status" "sched next" "bars took";
    gap: 10px 12px;
    padding: 14px 16px;
  }
  .row:first-of-type { border-top: 0; }
  .row > :nth-child(1) { grid-area: job; }
  .row > :nth-child(2) { grid-area: sched; }
  .row > :nth-child(3) { grid-area: next; text-align: right; justify-items: end; }
  .row > :nth-child(4) { grid-area: bars; max-width: 320px; }
  .row > :nth-child(5) { grid-area: status; justify-self: end; }
  .row > :nth-child(6) { grid-area: took; }
  .foot { padding: 12px 16px; }
}
</style>
