<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
import { t } from "../i18n";
import { clock, dayLabel, describeCron, duration, errorText, nextRuns, relative, shortDateTime } from "../format";
import { go, href } from "../router";
import { appendPage, fetchExecutions, jobState, jobsById, refresh, succeedsOn2xx } from "../store";
import { RUNTIME_LABEL, type Execution, type Job } from "../types";
import HeaderArt from "./HeaderArt.vue";
import Icon from "./Icon.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail"] }>();

const PAGE = 50;
const job = computed<Job | undefined>(() => jobsById.value.get(props.id));
const runs = ref<Execution[]>([]);
const runsLoaded = ref(false);
const more = ref(false);
const busy = ref<"" | "run" | "toggle" | "delete" | "more">("");
const error = ref("");

async function loadRuns(before?: number): Promise<void> {
  const rows = await fetchExecutions(`/jobs/${props.id}/executions`, PAGE, before);
  if (before) {
    const page = appendPage(runs.value, rows);
    runs.value = page.list;
    more.value = rows.length === PAGE && page.added > 0;
  } else {
    runs.value = rows;
    more.value = rows.length === PAGE;
  }
  runsLoaded.value = true;
}

watch(
  () => props.id,
  async () => {
    runs.value = [];
    runsLoaded.value = false;
    error.value = "";
    try {
      await loadRuns();
    } catch (caught) {
      error.value = errorText(caught);
    }
  },
  { immediate: true },
);

async function loadMore(): Promise<void> {
  const last = runs.value[runs.value.length - 1];
  if (!last) return;
  busy.value = "more";
  try {
    await loadRuns(last.started_at + 1);
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = "";
  }
}

async function runNow(): Promise<void> {
  busy.value = "run";
  error.value = "";
  try {
    const { result } = await api<{ result: Execution }>(`/jobs/${props.id}/run`, { method: "POST" });
    emit("toast", result.ok ? t(`Run succeeded in ${duration(result.duration_ms)}`, `运行成功，耗时 ${duration(result.duration_ms)}`) : t("Run failed", "运行失败"), result.ok ? "ok" : "fail");
    await Promise.all([refresh(), loadRuns()]);
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = "";
  }
}

async function toggle(): Promise<void> {
  if (!job.value) return;
  busy.value = "toggle";
  try {
    await api(`/jobs/${props.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !job.value.enabled }) });
    await refresh();
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = "";
  }
}

async function remove(): Promise<void> {
  if (!job.value || !confirm(t(`Delete "${job.value.name}" and its run history?`, `删除「${job.value.name}」及其运行记录？`))) return;
  busy.value = "delete";
  try {
    await api(`/jobs/${props.id}`, { method: "DELETE" });
    await refresh();
    emit("toast", t("Job deleted", "任务已删除"));
    go(href.jobs);
  } catch (caught) {
    error.value = errorText(caught);
    busy.value = "";
  }
}

const stats = computed(() => {
  const list = runs.value;
  const failed = list.filter((e) => !e.ok).length;
  const lastOk = list.find((e) => e.ok);
  return {
    count: list.length,
    failed,
    rate: list.length ? ((list.length - failed) / list.length) * 100 : null,
    avg: list.length ? list.reduce((s, e) => s + e.duration_ms, 0) / list.length : null,
    lastOk: lastOk?.started_at ?? null,
  };
});

// Bars scale to the timeout when runs come close to it; fast jobs scale to their slowest run so the bars stay readable.
const chart = computed(() => {
  const timeout = job.value?.timeout_ms ?? 30_000;
  const shown = runs.value.slice(0, 60).reverse();
  const slowest = Math.max(0, ...shown.map((e) => e.duration_ms));
  const scale = Math.min(timeout, Math.max(slowest * 1.25, 50));
  return {
    scale,
    atTimeout: scale === timeout,
    bars: shown.map((e) => ({ id: e.id, h: `${Math.max(2, Math.min(100, (e.duration_ms / scale) * 100))}%`, f: !e.ok, tip: `${shortDateTime(e.started_at)} · ${duration(e.duration_ms)}` })),
  };
});

const latest = computed(() => runs.value[0]);
const upcoming = computed(() => (job.value?.enabled ? nextRuns(job.value.cron, 5) : []));

const kindLabel = computed(() => {
  if (!job.value) return "";
  if (job.value.type === "url") return t(`HTTP job · ${job.value.method}`, `HTTP 任务 · ${job.value.method}`);
  const runtime = RUNTIME_LABEL[job.value.runtime];
  return t(`Script job · ${runtime}`, `脚本任务 · ${runtime}`);
});

function targetLabel(target: NonNullable<Job["notify_targets"]>[number]): { name: string; detail: string } {
  const names: Record<string, string> = { http: "Webhook", lark: t("Lark", "飞书"), telegram: "Telegram", dingtalk: t("DingTalk", "钉钉"), slack: "Slack", discord: "Discord" };
  if (target.type === "telegram") return { name: names.telegram, detail: `chat ${target.chat_id}` };
  let host = target.url;
  try {
    host = new URL(target.url).host;
  } catch {
    // keep the raw value
  }
  return { name: names[target.type], detail: host };
}
</script>

<template>
  <div v-if="!job" class="card" style="padding: 40px; text-align: center">
    <p class="serif" style="font-size: 24px; margin: 0">{{ t("Job not found", "找不到这个任务") }}</p>
    <p class="muted"><a class="link" :href="href.jobs">{{ t("Back to cron jobs", "返回定时任务") }}</a></p>
  </div>

  <template v-else>
    <a :href="href.jobs" class="muted back"><Icon name="back" />{{ t("Cron jobs", "定时任务") }}</a>

    <div class="hd" style="align-items: flex-start">
      <div style="min-width: 0; flex: 1 1 420px">
        <span class="eyebrow">{{ kindLabel }}</span>
        <div style="display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-top: 14px">
          <h1 class="serif" style="margin: 0; overflow-wrap: anywhere">{{ job.name }}</h1>
          <StatusPill :state="jobState(job)" />
        </div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px">
          <span class="chip">{{ job.cron }}</span>
          <span v-if="describeCron(job.cron)" class="muted" style="font-size: 13px">{{ describeCron(job.cron) }}</span>
          <template v-if="job.type === 'url'">
            <span class="faint">·</span>
            <span class="mono muted ellipsis" style="font-size: 13px; max-width: 100%">{{ job.url }}</span>
          </template>
        </div>
        <div class="actions">
          <button type="button" class="btn" :disabled="busy !== ''" @click="toggle">
            <Icon :name="job.enabled ? 'pause' : 'play'" />{{ job.enabled ? t("Pause", "暂停") : t("Resume", "启用") }}
          </button>
          <a class="btn" :href="href.edit(job.id)"><Icon name="edit" />{{ t("Edit", "编辑") }}</a>
          <button type="button" class="btn primary" :disabled="busy !== ''" @click="runNow">
            <Icon name="play" />{{ busy === "run" ? t("Running…", "运行中…") : t("Run now", "立即运行") }}
          </button>
        </div>
      </div>
      <HeaderArt :failed="job.last_status === 'failed'" />
    </div>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div class="stats">
      <div class="card stat">
        <div class="muted" style="font-size: 13px">{{ t(`Success rate · last ${stats.count}`, `成功率 · 最近 ${stats.count} 次`) }}</div>
        <div class="v">{{ stats.rate == null ? "—" : stats.rate.toFixed(stats.rate === 100 ? 0 : 1) }}<small v-if="stats.rate != null">%</small></div>
        <div class="s" :style="stats.failed ? 'color: var(--fail)' : ''">{{ t(`${stats.failed} failed`, `${stats.failed} 次失败`) }}</div>
      </div>
      <div class="card stat">
        <div class="muted" style="font-size: 13px">{{ t("Average duration", "平均耗时") }}</div>
        <div class="v">{{ duration(stats.avg) }}</div>
        <div class="s">{{ t(`Timeout ${duration(job.timeout_ms)}`, `超时上限 ${duration(job.timeout_ms)}`) }}</div>
      </div>
      <div class="card stat">
        <div class="muted" style="font-size: 13px">{{ t("Last success", "上次成功") }}</div>
        <div class="v" style="font-size: 24px">{{ stats.lastOk ? relative(stats.lastOk) : "—" }}</div>
        <div class="s">{{ stats.lastOk ? shortDateTime(stats.lastOk) : t("None in loaded runs", "已加载的记录中没有") }}</div>
      </div>
      <div class="card stat">
        <div class="muted" style="font-size: 13px">{{ t("Next run", "下次运行") }}</div>
        <div class="v" style="font-size: 24px">{{ job.enabled ? relative(job.next_run_at) : t("Paused", "已暂停") }}</div>
        <div class="s">{{ job.enabled ? shortDateTime(job.next_run_at) : "—" }}</div>
      </div>
    </div>

    <div class="cols">
      <div class="main-col">
        <section class="card pad">
          <h3 class="serif">{{ t("Duration per run", "每次运行的耗时") }}</h3>
          <div v-if="chart.bars.length" class="chart" :class="{ relaxed: !chart.atTimeout }">
            <span v-if="chart.atTimeout" class="mono limit">{{ t(`timeout ${duration(job.timeout_ms)}`, `超时 ${duration(job.timeout_ms)}`) }}</span>
            <span v-else class="mono limit">{{ t(`top ${duration(Math.round(chart.scale))} · timeout ${duration(job.timeout_ms)}`, `顶部 ${duration(Math.round(chart.scale))} · 超时 ${duration(job.timeout_ms)}`) }}</span>
            <span v-for="bar in chart.bars" :key="bar.id" class="col" :title="bar.tip"><i :class="{ f: bar.f }" :style="{ height: bar.h }"></i></span>
          </div>
          <p v-else class="muted" style="margin: 14px 0 0; font-size: 14px">{{ t("No runs yet. Run it now to see the result here.", "还没有运行记录。点「立即运行」看看结果。") }}</p>
          <div v-if="chart.bars.length" class="mono faint" style="display: flex; justify-content: space-between; font-size: 11.5px; margin-top: 9px">
            <span>{{ shortDateTime(runs[Math.min(59, runs.length - 1)].started_at) }}</span><span>{{ shortDateTime(runs[0].started_at) }}</span>
          </div>
        </section>

        <section v-if="latest" class="card pad">
          <div class="sect-head">
            <h3 class="serif">{{ t("Latest output", "最近一次输出") }}</h3>
            <span class="mono faint" style="font-size: 12.5px">{{ shortDateTime(latest.started_at, true) }}</span>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px">
            <StatusPill :state="latest.ok ? 'ok' : 'fail'" :label="latest.status_code ? `${latest.status_code}` : undefined" />
            <span class="chip">{{ duration(latest.duration_ms) }}</span>
          </div>
          <pre v-if="latest.error" class="dark-pre" style="color: #f3b4b4">{{ latest.error }}</pre>
          <pre v-if="latest.response_snippet" class="dark-pre" :style="latest.error ? 'margin-top: 10px' : ''">{{ latest.response_snippet }}</pre>
          <p v-if="!latest.error && !latest.response_snippet" class="faint" style="margin: 0; font-size: 13.5px">{{ t("The run produced no output.", "这次运行没有输出。") }}</p>
          <p class="faint" style="margin: 10px 0 0; font-size: 12.5px">{{ t("The first 500 characters of the response or stdout are kept.", "保留响应或标准输出的前 500 个字符。") }}</p>
        </section>

        <section class="card pad runs-wrap">
          <div class="sect-head"><h3 class="serif">{{ t("Runs", "运行记录") }}</h3></div>
          <div class="runs-table">
            <div class="rr th"><span>{{ t("Started", "开始时间") }}</span><span>{{ t("Result", "结果") }}</span><span>{{ t("Code", "状态码") }}</span><span>{{ t("Took", "耗时") }}</span><span>{{ t("Detail", "说明") }}</span></div>
            <div v-for="run in runs" :key="run.id" class="rr">
              <span class="mono">{{ shortDateTime(run.started_at, true) }}</span>
              <span><StatusPill :state="run.ok ? 'ok' : 'fail'" /></span>
              <span class="mono">{{ run.status_code ?? "—" }}</span>
              <span class="mono">{{ duration(run.duration_ms) }}</span>
              <span v-if="run.error ?? run.response_snippet" class="muted ellipsis detail" style="font-size: 12.5px" :title="run.error ?? run.response_snippet ?? ''">{{ run.error ?? run.response_snippet ?? "" }}</span>
            </div>
            <p v-if="runsLoaded && !runs.length" class="muted" style="margin: 12px 0 0; font-size: 14px">{{ t("No runs yet.", "还没有运行记录。") }}</p>
            <p v-if="!runsLoaded" class="muted" style="margin: 12px 0 0; font-size: 14px">{{ t("Loading…", "加载中…") }}</p>
          </div>
          <button v-if="more" type="button" class="btn sm" style="margin-top: 14px" :disabled="busy === 'more'" @click="loadMore">
            {{ busy === "more" ? t("Loading…", "加载中…") : t("Load older runs", "加载更早的记录") }}
          </button>
        </section>
      </div>

      <div class="side-col">
        <section class="card pad">
          <h3 class="serif" style="margin-bottom: 14px">{{ t("Next 5 runs", "接下来 5 次") }}</h3>
          <div v-if="upcoming.length">
            <div v-for="(at, i) in upcoming" :key="at" class="nr">
              <span class="muted">{{ dayLabel(at) }}<template v-if="i === 0"> · {{ relative(at) }}</template></span>
              <b class="mono" :style="{ fontWeight: 500, fontSize: '13.5px', color: i === 0 ? 'var(--accent-ink)' : undefined }">{{ clock(at) }}</b>
            </div>
          </div>
          <p v-else class="muted" style="margin: 0; font-size: 14px">{{ t("Paused jobs don't run.", "已暂停的任务不会运行。") }}</p>
        </section>

        <section class="card pad">
          <h3 class="serif" style="margin-bottom: 14px">{{ t("Settings", "执行配置") }}</h3>
          <div class="kv">
            <div><span>{{ t("Timeout", "超时") }}</span><b class="mono">{{ duration(job.timeout_ms) }}</b></div>
            <div><span>{{ t("Succeeds when", "成功条件") }}</span><b class="mono">{{ succeedsOn2xx(job) ? "2xx" : "exit 0" }}</b></div>
            <template v-if="job.type === 'url'">
              <div><span>{{ t("Method", "方法") }}</span><b class="mono">{{ job.method }}</b></div>
              <div v-if="job.headers && Object.keys(job.headers).length"><span>{{ t("Headers", "请求头") }}</span><b class="mono">{{ Object.keys(job.headers).join(", ") }}</b></div>
              <div v-if="job.body"><span>{{ t("Body", "请求体") }}</span><b class="mono">{{ job.body.length }} B</b></div>
            </template>
            <template v-else>
              <div><span>{{ t("Script version", "脚本版本") }}</span><b class="mono">v{{ job.script_version }}</b></div>
            </template>
            <div><span>{{ t("Cron time zone", "cron 时区") }}</span><b class="mono">UTC</b></div>
          </div>
        </section>

        <section class="card pad">
          <div class="sect-head" style="margin-bottom: 14px">
            <h3 class="serif">{{ t("Alerts", "告警") }}</h3>
            <a class="link" :href="href.edit(job.id)">{{ t("Edit", "编辑") }}</a>
          </div>
          <div v-if="job.notify_targets?.length">
            <div v-for="(target, i) in job.notify_targets" :key="i" class="route">
              <span class="ri"><Icon name="bell" /></span>
              <span style="min-width: 0">{{ targetLabel(target).name }}<small class="faint ellipsis" style="display: block; font-size: 12.5px">{{ targetLabel(target).detail }}</small></span>
            </div>
          </div>
          <p v-else class="muted" style="margin: 0; font-size: 14px">{{ t("No alert channels. Failures only show up here.", "没有告警渠道，失败只会记录在这里。") }}</p>
          <p v-if="job.notify_targets?.length" class="muted foot-note">{{ t("Notifies when a run fails.", "运行失败时通知。") }}</p>
        </section>

        <button type="button" class="btn danger" :disabled="busy !== ''" @click="remove"><Icon name="trash" />{{ t("Delete job", "删除任务") }}</button>
      </div>
    </div>
  </template>
</template>

<style scoped>
.back { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; width: max-content; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
.cols { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start; }
.main-col { flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 22px; }
.side-col { flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 22px; }
.pad { padding: 22px 24px; }
.sect-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.chart { display: flex; height: 150px; align-items: stretch; gap: 3px; margin-top: 30px; border-bottom: 1px solid var(--line); position: relative; border-top: 1px dashed #ecb4b4; }
.limit { position: absolute; right: 0; top: -20px; font-size: 11px; color: var(--fail); }
.chart.relaxed { border-top-color: var(--line); }
.chart.relaxed .limit { color: var(--faint); }
.foot-note { margin: 14px 0 0; font-size: 13px; padding-top: 12px; border-top: 1px solid var(--line); }
.runs-wrap { overflow-x: auto; }
.runs-table { min-width: 560px; }
@media (max-width: 720px) {
  .pad { padding: 18px 16px; }
  /* Phones: four narrow columns, with the detail on its own line under each run. */
  .runs-table { min-width: 0; }
  .runs-table .rr { grid-template-columns: minmax(0, 1fr) 84px 36px 56px; gap: 6px 10px; padding: 10px 0; font-size: 13px; }
  .runs-table .rr.th > :last-child { display: none; }
  .runs-table .detail { grid-column: 1 / -1; }
  .runs-table .rr > .mono { white-space: nowrap; }
}
</style>
