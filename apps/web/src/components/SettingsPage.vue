<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { api } from "../api";
import { errorText } from "../format";
import { t } from "../i18n";
import { go, href } from "../router";
import { boot, canManage, jobs, loadProjects, projectFilter, projects, reset, workspace, workspaces } from "../store";
import type { Project, Workspace } from "../types";
import Icon from "./Icon.vue";

const props = defineProps<{ userId: string }>();
const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail" | "info"] }>();

const isOwner = computed(() => workspace.value?.role === "owner");

/* name */
const name = ref("");
const savingName = ref(false);
const nameError = ref("");
watch(() => workspace.value?.name, (value) => (name.value = value ?? ""), { immediate: true });

async function rename(): Promise<void> {
  nameError.value = "";
  const next = name.value.trim();
  if (!next) { nameError.value = t("Enter a name."); return; }
  savingName.value = true;
  try {
    const { workspace: saved } = await api<{ workspace: Workspace }>("/workspaces/current", { method: "PATCH", body: JSON.stringify({ name: next }) });
    workspaces.value = workspaces.value.map((item) => (item.id === saved.id ? { ...item, name: saved.name } : item));
    emit("toast", t("Changes saved"), "ok");
  } catch (caught) {
    nameError.value = errorText(caught);
  } finally {
    savingName.value = false;
  }
}

/* projects */
// Job counts come from the loaded list, which covers every project only when no single project is chosen.
const counts = computed(() => {
  const map = new Map<string, number>();
  for (const job of jobs.value) if (job.project_id) map.set(job.project_id, (map.get(job.project_id) ?? 0) + 1);
  return map;
});
const newProject = ref("");
const adding = ref(false);
const projectError = ref("");
const editingId = ref<string | null>(null);
const editName = ref("");
const editInput = ref<HTMLInputElement[] | null>(null);

async function addProject(): Promise<void> {
  projectError.value = "";
  const value = newProject.value.trim();
  if (!value) { projectError.value = t("Enter a name."); return; }
  adding.value = true;
  try {
    await api<{ project: Project }>("/projects", { method: "POST", body: JSON.stringify({ name: value }) });
    newProject.value = "";
    await loadProjects();
    emit("toast", t("Created {name}.", { name: value }), "ok");
  } catch (caught) {
    projectError.value = errorText(caught);
  } finally {
    adding.value = false;
  }
}

async function startEdit(project: Project): Promise<void> {
  editingId.value = project.id;
  editName.value = project.name;
  projectError.value = "";
  await nextTick();
  editInput.value?.[0]?.focus();
}

async function saveEdit(project: Project): Promise<void> {
  const value = editName.value.trim();
  if (!value || value === project.name) { editingId.value = null; return; }
  try {
    await api(`/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body: JSON.stringify({ name: value }) });
    editingId.value = null;
    await loadProjects();
  } catch (caught) {
    projectError.value = errorText(caught);
  }
}

async function removeProject(project: Project): Promise<void> {
  if (!confirm(t("Delete the project {name}?", { name: project.name }))) return;
  try {
    await api(`/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    await loadProjects();
    emit("toast", t("Deleted {name}.", { name: project.name }), "ok");
  } catch (caught) {
    projectError.value = errorText(caught);
  }
}

/* leaving and deleting */
const confirmName = ref("");
const deleting = ref(false);

async function deleteWorkspace(): Promise<void> {
  if (!workspace.value || confirmName.value.trim() !== workspace.value.name) return;
  deleting.value = true;
  try {
    const gone = workspace.value.name;
    await api("/workspaces/current", { method: "DELETE" });
    reset();
    await boot();
    emit("toast", t("Deleted {name}.", { name: gone }), "ok");
    go(href.jobs);
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  } finally {
    deleting.value = false;
  }
}

async function leave(): Promise<void> {
  if (!confirm(t("Leave {workspace}? You lose access to its jobs and secrets, and your API keys here stop working.", { workspace: workspace.value?.name ?? "" }))) return;
  try {
    const { members } = await api<{ members: { id: string; user_id: string }[] }>("/members");
    const self = members.find((member) => member.user_id === props.userId);
    if (!self) return;
    await api(`/members/${encodeURIComponent(self.id)}`, { method: "DELETE" });
    reset();
    await boot();
    emit("toast", t("You left the workspace."), "ok");
    go(href.jobs);
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  }
}
</script>

<template>
  <div class="hd">
    <div>
      <span class="eyebrow">{{ workspace?.name }}</span>
      <h1 class="serif">{{ t("Workspace settings") }}</h1>
    </div>
  </div>

  <form class="card sect" @submit.prevent="rename">
    <h3 class="serif">{{ t("Name") }}</h3>
    <label class="fld">
      <span class="sr-only">{{ t("Workspace name") }}</span>
      <input v-model="name" class="in" maxlength="60" :disabled="!canManage" autocomplete="off" />
      <small v-if="nameError" class="err">{{ nameError }}</small>
      <small v-else-if="!canManage">{{ t("Only owners and admins can rename the workspace.") }}</small>
    </label>
    <div v-if="canManage"><button type="submit" class="btn primary" :disabled="savingName || name.trim() === workspace?.name">{{ t("Save") }}</button></div>
  </form>

  <section class="card sect">
    <div>
      <h3 class="serif">{{ t("Projects") }}</h3>
      <p class="muted" style="margin: 6px 0 0; font-size: 14px">
        {{ t("Projects group jobs inside the workspace. API keys can be limited to some of them.") }}
      </p>
    </div>
    <div class="plist">
      <div v-for="project in projects" :key="project.id" class="prow">
        <form v-if="editingId === project.id" class="pedit" @submit.prevent="saveEdit(project)">
          <input ref="editInput" v-model="editName" class="in" maxlength="60" :aria-label="t('Project name')" @keydown.esc="editingId = null" />
          <button type="submit" class="btn sm primary">{{ t("Save") }}</button>
          <button type="button" class="btn sm" @click="editingId = null">{{ t("Cancel") }}</button>
        </form>
        <template v-else>
          <span class="ellipsis" style="font-weight: 500">{{ project.name }}</span>
          <span class="faint" style="font-size: 13px">{{ projectFilter === "all" ? t("{n} jobs", { n: counts.get(project.id) ?? 0 }) : "" }}</span>
          <span v-if="canManage" class="acts">
            <button type="button" class="btn sm" @click="startEdit(project)"><Icon name="edit" />{{ t("Rename") }}</button>
            <button type="button" class="btn sm danger" :disabled="projects.length === 1" :title="projects.length === 1 ? t('A workspace keeps at least one project') : ''" @click="removeProject(project)">
              <Icon name="trash" />{{ t("Delete") }}
            </button>
          </span>
        </template>
      </div>
    </div>
    <form v-if="canManage" class="padd" @submit.prevent="addProject">
      <input v-model="newProject" class="in" maxlength="60" :placeholder="t('New project name')" :aria-label="t('New project name')" autocomplete="off" />
      <button type="submit" class="btn" :disabled="adding"><Icon name="plus" />{{ t("Add project") }}</button>
    </form>
    <p v-if="projectError" class="alert" role="alert" style="margin: 0">{{ projectError }}</p>
  </section>

  <section class="card sect danger-zone">
    <h3 class="serif">{{ isOwner ? t("Delete workspace") : t("Leave workspace") }}</h3>
    <template v-if="isOwner">
      <p class="muted" style="margin: 0; font-size: 14px">
        {{ t("Deletes every job, run, secret and API key in this workspace, and removes all members. This cannot be undone.") }}
      </p>
      <label class="fld">
        {{ t("Type {name} to confirm", { name: workspace?.name ?? "" }) }}
        <input v-model="confirmName" class="in" autocomplete="off" />
      </label>
      <div>
        <button type="button" class="btn danger" :disabled="deleting || confirmName.trim() !== workspace?.name" @click="deleteWorkspace">
          {{ deleting ? t("Deleting…") : t("Delete workspace") }}
        </button>
      </div>
    </template>
    <template v-else>
      <p class="muted" style="margin: 0; font-size: 14px">{{ t("You lose access to its jobs and secrets. An owner or admin can invite you again.") }}</p>
      <div><button type="button" class="btn danger" @click="leave">{{ t("Leave workspace") }}</button></div>
    </template>
  </section>
</template>

<style scoped>
.plist { display: grid; }
.prow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 14px; align-items: center; min-height: 52px; border-top: 1px solid var(--line); font-size: 14px; }
.prow:first-child { border-top: 0; }
.pedit { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; }
.pedit .in { flex: 1; min-width: 0; }
.acts { display: flex; gap: 6px; justify-content: flex-end; }
.padd { display: flex; gap: 8px; }
.padd .in { flex: 1; min-width: 0; max-width: 360px; }
.danger-zone { border-color: #f0d0d0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 720px) {
  .prow { grid-template-columns: minmax(0, 1fr) auto; }
  .prow > .acts { grid-column: 1 / -1; justify-content: flex-start; }
}
</style>
