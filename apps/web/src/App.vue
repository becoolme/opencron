<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { authClient } from "./auth-client";
import AppShell from "./components/AppShell.vue";
import AuthPanel from "./components/AuthPanel.vue";
import JobDetail from "./components/JobDetail.vue";
import JobEditor from "./components/JobEditor.vue";
import JobsList from "./components/JobsList.vue";
import RunsPage from "./components/RunsPage.vue";
import { t } from "./i18n";
import { href, route } from "./router";
import { jobsById, loadError, loadMeta, loaded, refresh, reset } from "./store";

const sessionState = authClient.useSession();
const session = computed(() => sessionState.value.data);
const sessionPending = computed(() => sessionState.value.isPending);

watch(
  () => session.value?.user.id,
  async (userId) => {
    reset();
    if (userId) await Promise.all([refresh(), loadMeta()]);
  },
  { immediate: true },
);

// Keep run results fresh while the tab is visible.
let timer: ReturnType<typeof setInterval> | undefined;
function tick(): void {
  if (session.value && document.visibilityState === "visible") void refresh();
}
function onVisible(): void {
  if (document.visibilityState === "visible") tick();
}
onMounted(() => {
  timer = setInterval(tick, 30_000);
  document.addEventListener("visibilitychange", onVisible);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisible);
});

const toast = ref<{ text: string; kind: "ok" | "fail" | "info"; id: number } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, kind: "ok" | "fail" | "info" = "info"): void {
  clearTimeout(toastTimer);
  toast.value = { text, kind, id: Date.now() };
  toastTimer = setTimeout(() => (toast.value = null), 4500);
}

const crumbs = computed(() => {
  const jobs = { label: t("Cron jobs", "定时任务"), href: href.jobs };
  const r = route.value;
  switch (r.name) {
    case "runs": return [{ label: t("Runs", "运行记录") }];
    case "new": return [jobs, { label: t("New job", "新建任务") }];
    case "job": return [jobs, { label: jobsById.value.get(r.id)?.name ?? `#${r.id}` }];
    case "edit": return [jobs, { label: jobsById.value.get(r.id)?.name ?? `#${r.id}`, href: href.job(r.id) }, { label: t("Edit", "编辑") }];
    default: return [{ label: t("Cron jobs", "定时任务") }];
  }
});

watch(
  crumbs,
  (list) => {
    document.title = `${list[list.length - 1].label} · OpenCron`;
  },
  { immediate: true },
);

async function signOut(): Promise<void> {
  await authClient.signOut();
  await sessionState.value.refetch();
}
</script>

<template>
  <main v-if="sessionPending" class="boot muted">{{ t("Loading OpenCron…", "正在加载 OpenCron…") }}</main>

  <AuthPanel v-else-if="!session" @authenticated="sessionState.refetch()" />

  <AppShell v-else :user="session.user" :crumbs="crumbs" @sign-out="signOut">
    <p v-if="loadError && loaded" class="alert" role="alert">
      {{ t("Couldn't load your jobs:", "无法加载任务：") }} {{ loadError }}
      <button type="button" class="btn sm" style="margin-left: 8px" @click="refresh()">{{ t("Retry", "重试") }}</button>
    </p>

    <p v-if="!loaded" class="muted" style="padding: 40px 0">{{ t("Loading…", "加载中…") }}</p>
    <template v-else>
      <JobsList v-if="route.name === 'jobs'" />
      <RunsPage v-else-if="route.name === 'runs'" />
      <JobEditor v-else-if="route.name === 'new'" key="new" @toast="showToast" />
      <JobEditor v-else-if="route.name === 'edit'" :key="`edit-${route.id}`" :id="route.id" @toast="showToast" />
      <JobDetail v-else-if="route.name === 'job'" :id="route.id" @toast="showToast" />
    </template>
  </AppShell>

  <div class="toast-host" aria-live="polite">
    <div v-if="toast" :key="toast.id" class="toast" :class="toast.kind" role="status">
      {{ toast.text }}
      <button type="button" class="toast-x" :aria-label="t('Dismiss', '关闭')" @click="toast = null">×</button>
    </div>
  </div>
</template>

<style scoped>
.boot { min-height: 100vh; display: grid; place-items: center; font-size: 14px; }
.toast-host { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 50; width: max-content; max-width: calc(100vw - 32px); }
.toast { display: flex; align-items: center; gap: 12px; padding: 11px 12px 11px 16px; border-radius: 12px; background: var(--ink); color: #fff; font-size: 14px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18); animation: rise 0.18s ease-out; }
.toast.ok::before, .toast.fail::before { content: ""; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.toast.ok::before { background: #6fd39a; }
.toast.fail::before { background: #ff8a8a; }
.toast-x { border: 0; background: transparent; color: #aab4bf; font-size: 18px; line-height: 1; padding: 0 4px; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
</style>
