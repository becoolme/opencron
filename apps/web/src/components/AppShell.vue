<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { t } from "../i18n";
import LangSwitch from "./LangSwitch.vue";
import { errorText, localZone } from "../format";
import { go, href, route } from "../router";
import { canManage, jobs, projectFilter, projects, setProject, switchWorkspace, workspace, workspaces } from "../store";
import type { Workspace } from "../types";
import Icon from "./Icon.vue";

defineProps<{ user: { name: string; email: string }; crumbs: { label: string; href?: string }[] }>();
const emit = defineEmits<{ signOut: []; toast: [text: string, kind?: "ok" | "fail" | "info"] }>();

const ROLE_LABEL = computed(() => ({ owner: t("Owner"), admin: t("Admin"), member: t("Member") }));

// The workspace menu: switch, or create one.
const wsOpen = ref(false);
const creating = ref(false);
const newName = ref("");
const wsBusy = ref(false);
const wsError = ref("");

function toggleWorkspaces(): void {
  wsOpen.value = !wsOpen.value;
  creating.value = false;
  wsError.value = "";
}

async function pick(item: Workspace): Promise<void> {
  wsOpen.value = false;
  if (item.id === workspace.value?.id) return;
  try {
    await switchWorkspace(item.id);
    go(href.jobs);
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  }
}

async function createWorkspace(): Promise<void> {
  const name = newName.value.trim();
  if (!name) { wsError.value = t("Enter a name."); return; }
  wsBusy.value = true;
  wsError.value = "";
  try {
    const { workspace: created } = await api<{ workspace: Workspace }>("/workspaces", { method: "POST", body: JSON.stringify({ name }) });
    await switchWorkspace(created.id);
    wsOpen.value = false;
    creating.value = false;
    newName.value = "";
    emit("toast", t("Created {name}.", { name }), "ok");
    go(href.jobs);
  } catch (caught) {
    wsError.value = errorText(caught);
  } finally {
    wsBusy.value = false;
  }
}

const wsRoot = ref<HTMLElement | null>(null);
function onOutside(event: MouseEvent): void {
  if (wsOpen.value && wsRoot.value && !wsRoot.value.contains(event.target as Node)) wsOpen.value = false;
}
onMounted(() => document.addEventListener("click", onOutside));
onBeforeUnmount(() => document.removeEventListener("click", onOutside));

function onProject(event: Event): void {
  setProject((event.target as HTMLSelectElement).value);
}

const failing = computed(() => jobs.value.filter((job) => job.enabled && job.last_status === "failed").length);
const onJobs = computed(() => ["jobs", "new", "job", "edit"].includes(route.value.name));
const on = (name: string) => route.value.name === name;
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
          <span class="mark" aria-hidden="true">*/</span>
          <span>OpenCron</span>
        </a>
        <button
          type="button"
          ref="menuButton"
          class="btn sm menu-btn"
          :aria-expanded="menuOpen"
          aria-controls="side-nav"
          :aria-label="t('Menu')"
          @click="menuOpen = !menuOpen"
        >
          <Icon :name="menuOpen ? 'x' : 'list'" />
        </button>
      </div>
      <div class="scope">
        <div ref="wsRoot" class="ws" @keydown.esc.stop="wsOpen = false">
          <button type="button" class="ws-btn" :aria-expanded="wsOpen" aria-haspopup="true" @click="toggleWorkspaces">
            <span class="ws-mark" aria-hidden="true">{{ (workspace?.name ?? "?").slice(0, 1).toUpperCase() }}</span>
            <span class="ws-name">
              <b class="ellipsis">{{ workspace?.name ?? t("Loading…") }}</b>
              <small class="faint">{{ workspace ? ROLE_LABEL[workspace.role] : "" }}</small>
            </span>
            <span class="faint" aria-hidden="true">▾</span>
          </button>
          <div v-if="wsOpen" class="ws-menu card">
            <small class="faint ws-label">{{ t("Workspaces") }}</small>
            <button v-for="item in workspaces" :key="item.id" type="button" class="ws-item" :class="{ on: item.id === workspace?.id }" :aria-current="item.id === workspace?.id ? 'true' : undefined" @click="pick(item)">
              <span class="ellipsis">{{ item.name }}</span><small class="faint">{{ ROLE_LABEL[item.role] }}</small>
            </button>
            <form v-if="creating" class="ws-new" @submit.prevent="createWorkspace">
              <input v-model="newName" class="in" maxlength="60" :placeholder="t('Workspace name')" :aria-label="t('Workspace name')" autocomplete="off" />
              <small v-if="wsError" class="err">{{ wsError }}</small>
              <div style="display: flex; gap: 6px">
                <button type="submit" class="btn sm primary" :disabled="wsBusy">{{ wsBusy ? t("Creating…") : t("Create") }}</button>
                <button type="button" class="btn sm" @click="creating = false">{{ t("Cancel") }}</button>
              </div>
            </form>
            <button v-else type="button" class="ws-item add" @click="creating = true"><Icon name="plus" /><span>{{ t("New workspace") }}</span></button>
          </div>
        </div>
        <label v-if="projects.length > 1" class="proj">
          <span class="faint">{{ t("Project") }}</span>
          <select class="in" :value="projectFilter" @change="onProject">
            <option value="all">{{ t("All projects") }}</option>
            <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
          </select>
        </label>
      </div>
      <nav id="side-nav" class="side-nav" @click="menuOpen = false">
        <a class="nav" :class="{ on: onJobs }" :href="href.jobs" :aria-current="onJobs ? 'page' : undefined">
          <Icon name="list" /><span>{{ t("Cron jobs") }}</span><em>{{ jobs.length }}</em>
        </a>
        <a class="nav" :class="{ on: on('runs') }" :href="href.runs" :aria-current="on('runs') ? 'page' : undefined">
          <Icon name="activity" /><span>{{ t("Runs") }}</span>
          <em v-if="failing" class="bad" :title="t('Jobs whose last run failed')">{{ failing }}</em>
        </a>
        <a class="nav" :class="{ on: on('secrets') }" :href="href.secrets" :aria-current="on('secrets') ? 'page' : undefined">
          <Icon name="lock" /><span>{{ t("Secrets") }}</span>
        </a>
        <a class="nav" :class="{ on: on('channels') }" :href="href.channels" :aria-current="on('channels') ? 'page' : undefined">
          <Icon name="bell" /><span>{{ t("Alert channels") }}</span>
        </a>
        <a v-if="canManage" class="nav" :class="{ on: on('keys') }" :href="href.keys" :aria-current="on('keys') ? 'page' : undefined">
          <Icon name="key" /><span>{{ t("API & MCP") }}</span>
        </a>
        <span class="nav-sep" aria-hidden="true"></span>
        <a class="nav" :class="{ on: on('members') }" :href="href.members" :aria-current="on('members') ? 'page' : undefined">
          <Icon name="users" /><span>{{ t("Members") }}</span>
        </a>
        <a class="nav" :class="{ on: on('settings') }" :href="href.settings" :aria-current="on('settings') ? 'page' : undefined">
          <Icon name="settings" /><span>{{ t("Workspace settings") }}</span>
        </a>
      </nav>
      <div class="side-foot">
        <div class="who">
          <span class="ellipsis" style="font-weight: 500; font-size: 14px">{{ user.name }}</span>
          <small class="ellipsis faint" style="font-size: 12px">{{ user.email }}</small>
        </div>
        <button type="button" class="btn sm" :title="t('Sign out')" :aria-label="t('Sign out')" @click="emit('signOut')">
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
          <span class="chip" :title="t('Times are shown in this time zone. Cron expressions run in UTC.')">{{ localZone }}</span>
          <LangSwitch />
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
.mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); display: grid; place-items: center; color: #fff; font: 600 15px var(--mono-font); letter-spacing: -0.02em; }
.menu-btn { display: none; padding: 0; width: 36px; }
.side-nav { display: grid; gap: 2px; }
.nav-sep { height: 1px; background: var(--line); margin: 8px 8px; }
.scope { display: grid; gap: 10px; padding: 0 0 14px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
.ws { position: relative; }
.ws-btn { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: 1px solid var(--line); border-radius: 10px; background: #fff; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.ws-btn:hover { background: var(--surface); }
.ws-mark { flex: none; width: 26px; height: 26px; border-radius: 7px; background: var(--surface); border: 1px solid var(--line); display: grid; place-items: center; font-weight: 600; font-size: 13px; }
.ws-name { display: grid; min-width: 0; flex: 1; line-height: 1.2; }
.ws-name b { font-weight: 500; font-size: 14px; }
.ws-name small { font-size: 12px; }
.ws-menu { position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; right: 0; padding: 6px; display: grid; gap: 2px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12); max-height: 60vh; overflow: auto; }
.ws-label { padding: 4px 8px; font-size: 12px; }
.ws-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 0; border-radius: 8px; background: transparent; font: inherit; font-size: 14px; color: inherit; text-align: left; cursor: pointer; min-width: 0; }
.ws-item:hover, .ws-item.on { background: var(--surface); }
.ws-item.on span { font-weight: 500; }
.ws-item.add { justify-content: flex-start; color: var(--muted); border-top: 1px solid var(--line); border-radius: 0 0 8px 8px; margin-top: 4px; }
.ws-new { display: grid; gap: 6px; padding: 8px; border-top: 1px solid var(--line); margin-top: 4px; }
.proj { display: grid; gap: 4px; font-size: 12px; padding: 0 2px; }
.proj select { height: 36px; font-size: 14px; }
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
  .side-nav, .side-foot, .scope { display: none; }
  .side.open .scope { display: grid; padding-top: 10px; }
  .side.open .side-nav { display: grid; padding-top: 10px; }
  .side.open .side-foot { display: flex; margin-top: 10px; }
  .topbar .chip { display: none; }
}
</style>
