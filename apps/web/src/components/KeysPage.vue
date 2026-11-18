<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { errorText, relative, shortDateTime } from "../format";
import { t } from "../i18n";
import { projects, projectsById, workspace } from "../store";
import Icon from "./Icon.vue";

type Scope = "read" | "write";
interface ApiKey {
  id: string; name: string; prefix: string; scope: Scope; project_ids: string[] | null; created_by: string | null;
  created_at: number; last_used_at: number | null;
}

const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail" | "info"] }>();

const keys = ref<ApiKey[]>([]);
const loaded = ref(false);
const error = ref("");

const open = ref(false);
const name = ref("");
const scope = ref<Scope>("read");
// empty: every project, including ones added later
const limitTo = ref<string[]>([]);
const saving = ref(false);
const formError = ref("");
// the key just created, shown once
const created = ref<{ name: string; token: string } | null>(null);

async function load(): Promise<void> {
  error.value = "";
  try {
    keys.value = (await api<{ keys: ApiKey[] }>("/keys")).keys;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

function startNew(): void {
  name.value = "";
  scope.value = "read";
  limitTo.value = [];
  formError.value = "";
  created.value = null;
  open.value = true;
}

async function create(): Promise<void> {
  formError.value = "";
  if (!name.value.trim()) { formError.value = t("Enter a name."); return; }
  saving.value = true;
  try {
    const result = await api<{ key: ApiKey; token: string }>("/keys", {
      method: "POST",
      body: JSON.stringify({ name: name.value.trim(), scope: scope.value, project_ids: limitTo.value.length ? limitTo.value : null }),
    });
    created.value = { name: result.key.name, token: result.token };
    open.value = false;
    await load();
  } catch (caught) {
    formError.value = errorText(caught);
  } finally {
    saving.value = false;
  }
}

async function revoke(key: ApiKey): Promise<void> {
  if (!confirm(t("Revoke {name}? Anything using it will be refused at once.", { name: key.name }))) return;
  try {
    await api(`/keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
    emit("toast", t("Revoked {name}.", { name: key.name }), "ok");
    await load();
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    emit("toast", t("Copied."), "ok");
  } catch {
    emit("toast", t("Could not copy. Select the text and copy it yourself."), "fail");
  }
}

function projectNames(key: ApiKey): string {
  if (!key.project_ids) return t("All projects");
  return key.project_ids.map((id) => projectsById.value.get(id)?.name ?? id).join(", ");
}

const origin = window.location.origin;
const mcpUrl = `${origin}/api/mcp`;
const shownKey = computed(() => created.value?.token ?? "oc_…");
const claudeCommand = computed(() =>
  `claude mcp add --transport http opencron ${mcpUrl} --header "Authorization: Bearer ${shownKey.value}"`);
const mcpJson = computed(() => JSON.stringify({
  mcpServers: { opencron: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${shownKey.value}` } } },
}, null, 2));
const curl = computed(() => `curl ${origin}/api/jobs \\\n  -H "Authorization: Bearer ${shownKey.value}"`);
const docsUrl = "https://github.com/becoolme/opencron/blob/main/docs/api.md";
</script>

<template>
  <div class="hd">
    <div>
      <span class="eyebrow">{{ workspace?.name }}</span>
      <h1 class="serif">{{ t("API & MCP") }}</h1>
      <p class="muted" style="margin: 12px 0 0; font-size: 15px; max-width: 560px">
        {{ t("Keys let scripts, CI and AI assistants manage this workspace's jobs and secrets without your password.") }}
      </p>
    </div>
    <button type="button" class="btn primary" @click="startNew"><Icon name="plus" />{{ t("Create API key") }}</button>
  </div>

  <p v-if="error" class="alert" role="alert">{{ error }} <button type="button" class="btn sm" style="margin-left: 8px" @click="load()">{{ t("Retry") }}</button></p>

  <div v-if="created" class="card sect reveal" role="status">
    <h3 class="serif">{{ t("Copy {name} now", { name: created.name }) }}</h3>
    <p class="muted" style="margin: 0; font-size: 14px">{{ t("This is the only time the key is shown. Store it somewhere safe; if you lose it, create a new one.") }}</p>
    <div class="token">
      <code class="mono">{{ created.token }}</code>
      <button type="button" class="btn sm" @click="copy(created.token)">{{ t("Copy") }}</button>
    </div>
    <div><button type="button" class="btn sm" @click="created = null">{{ t("Done") }}</button></div>
  </div>

  <form v-if="open" class="card" @submit.prevent="create">
    <div class="sect">
      <h3 class="serif">{{ t("New API key") }}</h3>
      <label class="fld">
        {{ t("Name") }}
        <input v-model="name" class="in" maxlength="60" :placeholder="t('e.g. GitHub Actions')" autocomplete="off" />
        <small>{{ t("So you can tell keys apart later.") }}</small>
      </label>
      <div class="fld">
        {{ t("Access") }}
        <div class="seg" role="radiogroup" :aria-label="t('Access')">
          <button type="button" role="radio" :class="{ on: scope === 'read' }" :aria-checked="scope === 'read'" @click="scope = 'read'">{{ t("Read only") }}</button>
          <button type="button" role="radio" :class="{ on: scope === 'write' }" :aria-checked="scope === 'write'" @click="scope = 'write'">{{ t("Read and write") }}</button>
        </div>
        <small>{{ scope === "read"
          ? t("Can list jobs, runs and secret names. Cannot change anything.")
          : t("Can also create, change, run and delete jobs, and set secrets.") }}</small>
      </div>
      <fieldset v-if="projects.length > 1" class="fld projs">
        <legend>{{ t("Projects") }}</legend>
        <label v-for="project in projects" :key="project.id" class="check">
          <input v-model="limitTo" type="checkbox" :value="project.id" />{{ project.name }}
        </label>
        <small>{{ limitTo.length ? t("The key sees only the jobs in the projects you tick.") : t("No project ticked: the key works in every project, including ones added later.") }}</small>
      </fieldset>
      <p v-if="formError" class="alert" role="alert" style="margin: 0">{{ formError }}</p>
      <div style="display: flex; gap: 8px">
        <button type="submit" class="btn primary" :disabled="saving">{{ saving ? t("Creating…") : t("Create key") }}</button>
        <button type="button" class="btn" @click="open = false">{{ t("Cancel") }}</button>
      </div>
    </div>
  </form>

  <div class="card">
    <div class="list">
      <div class="krow th"><span>{{ t("Name") }}</span><span>{{ t("Key") }}</span><span>{{ t("Access") }}</span><span>{{ t("Last used") }}</span><span /></div>
      <div v-for="key in keys" :key="key.id" class="krow">
        <span class="who">
          <b class="ellipsis">{{ key.name }}</b>
          <small v-if="projects.length > 1 || key.project_ids" class="faint ellipsis">{{ projectNames(key) }}</small>
        </span>
        <span class="mono faint">{{ key.prefix }}…</span>
        <span><span class="chip">{{ key.scope === "write" ? t("Read and write") : t("Read only") }}</span></span>
        <span class="mono faint" :title="key.last_used_at ? shortDateTime(key.last_used_at) : ''">{{ key.last_used_at ? relative(key.last_used_at) : t("Never") }}</span>
        <span class="acts">
          <button type="button" class="btn sm danger" @click="revoke(key)">{{ t("Revoke") }}</button>
        </span>
      </div>
      <p v-if="!loaded" class="muted empty">{{ t("Loading…") }}</p>
      <p v-else-if="!keys.length && !error" class="muted empty">{{ t("No API keys yet.") }}</p>
    </div>
  </div>

  <div class="card sect">
    <h3 class="serif">{{ t("Connect an AI assistant (MCP)") }}</h3>
    <p class="muted" style="margin: 0; font-size: 14px">
      {{ t("Clients that speak MCP over HTTP can list, create, run and pause jobs and manage secrets. A read-only key keeps them to reading.") }}
    </p>
    <div class="fld">
      {{ t("Endpoint") }}
      <div class="token"><code class="mono">{{ mcpUrl }}</code><button type="button" class="btn sm" @click="copy(mcpUrl)">{{ t("Copy") }}</button></div>
    </div>
    <div class="fld">
      Claude Code
      <pre class="dark-pre">{{ claudeCommand }}</pre>
    </div>
    <div class="fld">
      {{ t("Other clients (JSON config)") }}
      <pre class="dark-pre">{{ mcpJson }}</pre>
    </div>
  </div>

  <div class="card sect">
    <h3 class="serif">{{ t("REST API") }}</h3>
    <p class="muted" style="margin: 0; font-size: 14px">
      {{ t("The same endpoints the app uses, with the key in the Authorization header.") }}
      <a class="link" :href="docsUrl" target="_blank" rel="noopener">{{ t("Read the API reference") }}</a>
    </p>
    <pre class="dark-pre">{{ curl }}</pre>
  </div>
</template>

<style scoped>
.list { padding: 6px 22px 10px; }
.krow { display: grid; grid-template-columns: minmax(120px, 1.2fr) 90px 130px 110px auto; gap: 14px; align-items: center; min-height: 52px; border-top: 1px solid var(--line); font-size: 14px; }
.krow.th { min-height: 36px; border-top: 0; }
.krow > span { min-width: 0; }
.acts { display: flex; justify-content: flex-end; }
.who { display: grid; line-height: 1.3; }
.who b { font-weight: 500; }
.projs { border: 0; padding: 0; margin: 0; display: grid; gap: 6px; }
.projs legend { padding: 0; margin-bottom: 6px; }
.check { display: flex; gap: 8px; align-items: center; font-weight: 400; }
.empty { margin: 0; padding: 24px 0 16px; font-size: 14px; }
.token { display: flex; gap: 10px; align-items: center; padding: 10px 12px 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.token code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13.5px; }
.reveal { border-color: #b9d8c4; }
pre.dark-pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .krow.th { display: none; }
  .krow { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 12px 0; }
  .krow:nth-child(2) { border-top: 0; }
  .krow > :nth-child(2), .krow > :nth-child(3), .krow > :nth-child(4) { grid-column: 1; }
  .krow > .acts { grid-row: 1; grid-column: 2; }
}
</style>
