<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { lang, setLang, t } from "../i18n";
import { localZone } from "../format";
import { href, route } from "../router";
import { jobs } from "../store";
import Icon from "./Icon.vue";

defineProps<{ user: { name: string; email: string }; crumbs: { label: string; href?: string }[] }>();
const emit = defineEmits<{ signOut: [] }>();

const failing = computed(() => jobs.value.filter((job) => job.enabled && job.last_status === "failed").length);
const onJobs = computed(() => route.value.name !== "runs");
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement | null>(null);

// Back/forward and in-page links change the route without touching the nav.
watch(route, () => (menuOpen.value = false));

function closeMenu(): void {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  menuButton.value?.focus();
}
</script>

<template>
  <div class="shell">
    <aside class="side" :class="{ open: menuOpen }" @keydown.esc="closeMenu">
      <div class="side-head">
        <a :href="href.jobs" class="logo" @click="menuOpen = false">
          <span class="mark"><Icon name="clock" :size="18" /></span>
          <span>OpenCron</span>
        </a>
        <button
          type="button"
          ref="menuButton"
          class="btn sm menu-btn"
          :aria-expanded="menuOpen"
          aria-controls="side-nav"
          :aria-label="t('Menu', '菜单')"
          @click="menuOpen = !menuOpen"
        >
          <Icon :name="menuOpen ? 'x' : 'list'" />
        </button>
      </div>
      <nav id="side-nav" class="side-nav" @click="menuOpen = false">
        <a class="nav" :class="{ on: onJobs }" :href="href.jobs" :aria-current="onJobs ? 'page' : undefined">
          <Icon name="list" /><span>{{ t("Cron jobs", "定时任务") }}</span><em>{{ jobs.length }}</em>
        </a>
        <a class="nav" :class="{ on: !onJobs }" :href="href.runs" :aria-current="!onJobs ? 'page' : undefined">
          <Icon name="activity" /><span>{{ t("Runs", "运行记录") }}</span>
          <em v-if="failing" class="bad" :title="t('Jobs whose last run failed', '上次运行失败的任务')">{{ failing }}</em>
        </a>
      </nav>
      <div class="side-foot">
        <div class="who">
          <span class="ellipsis" style="font-weight: 500; font-size: 14px">{{ user.name }}</span>
          <small class="ellipsis faint" style="font-size: 12px">{{ user.email }}</small>
        </div>
        <button type="button" class="btn sm" :title="t('Sign out', '退出登录')" :aria-label="t('Sign out', '退出登录')" @click="emit('signOut')">
          <Icon name="logout" />
        </button>
      </div>
    </aside>

    <div class="body">
      <div class="topbar">
        <div class="muted ellipsis" style="font-size: 14px; min-width: 0">
          <template v-for="(crumb, index) in crumbs" :key="index">
            <span v-if="index > 0"> / </span>
            <a v-if="crumb.href" :href="crumb.href" class="muted">{{ crumb.label }}</a>
            <b v-else style="color: var(--ink); font-weight: 500">{{ crumb.label }}</b>
          </template>
        </div>
        <div style="display: flex; gap: 8px; align-items: center">
          <span class="chip" :title="t('Times are shown in this time zone. Cron expressions run in UTC.', '时间按此时区显示，cron 表达式按 UTC 运行。')">{{ localZone }}</span>
          <div class="seg" role="group" :aria-label="t('Language', '语言')" style="padding: 2px">
            <button type="button" :class="{ on: lang === 'en' }" style="height: 26px; padding: 0 9px; font-size: 12.5px" @click="setLang('en')">EN</button>
            <button type="button" :class="{ on: lang === 'zh' }" style="height: 26px; padding: 0 9px; font-size: 12.5px" @click="setLang('zh')">中</button>
          </div>
        </div>
      </div>
      <main class="shell-main">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; }
.side { flex: 0 0 240px; border-right: 1px solid var(--line); padding: 16px 12px; display: flex; flex-direction: column; gap: 2px; position: sticky; top: 0; height: 100vh; background: #fff; }
.side-head { display: flex; align-items: center; justify-content: space-between; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; padding: 2px 8px 14px; }
.mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); display: grid; place-items: center; color: #fff; }
.menu-btn { display: none; padding: 0; width: 36px; }
.side-nav { display: grid; gap: 2px; }
.side-foot { margin-top: auto; border-top: 1px solid var(--line); padding: 12px 4px 0 8px; display: flex; align-items: center; gap: 8px; }
.who { display: grid; line-height: 1.25; min-width: 0; flex: 1; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.topbar { min-height: 56px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 40px; border-bottom: 1px solid var(--line); }
.shell-main { padding: 36px 40px 56px; max-width: 1240px; width: 100%; display: flex; flex-direction: column; gap: 24px; }

@media (max-width: 900px) {
  .shell { flex-direction: column; }
  .side { position: sticky; z-index: 20; height: auto; flex: none; border-right: 0; border-bottom: 1px solid var(--line); padding: 10px 16px; }
  .logo { padding: 2px 0; }
  .menu-btn { display: inline-flex; }
  .side-nav, .side-foot { display: none; }
  .side.open .side-nav { display: grid; padding-top: 10px; }
  .side.open .side-foot { display: flex; margin-top: 10px; }
  .topbar .chip { display: none; }
}
</style>
