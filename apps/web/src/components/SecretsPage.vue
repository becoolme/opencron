<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { errorText, relative, shortDateTime } from "../format";
import { t } from "../i18n";
import Icon from "./Icon.vue";

interface Secret { name: string; note: string | null; created_at: number; updated_at: number }

const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail" | "info"] }>();

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const secrets = ref<Secret[]>([]);
const loaded = ref(false);
const error = ref("");

// the form: a new secret, or a new value for `editing`
const open = ref(false);
const editing = ref<string | null>(null);
const name = ref("");
const value = ref("");
const note = ref("");
const saving = ref(false);
const formError = ref("");

async function load(): Promise<void> {
  error.value = "";
  try {
    secrets.value = (await api<{ secrets: Secret[] }>("/secrets")).secrets;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

function startNew(): void {
  editing.value = null;
  name.value = "";
  value.value = "";
  note.value = "";
  formError.value = "";
  open.value = true;
}

function startEdit(secret: Secret): void {
  editing.value = secret.name;
  name.value = secret.name;
  value.value = "";
  note.value = secret.note ?? "";
  formError.value = "";
  open.value = true;
}

const nameProblem = computed(() => {
  if (editing.value || !name.value) return "";
  if (!NAME.test(name.value)) return t("Use capital letters, digits and underscores, not starting with a digit.");
  if (secrets.value.some((secret) => secret.name === name.value)) return t("A secret with this name exists. Edit it instead.");
  return "";
});

async function save(): Promise<void> {
  formError.value = "";
  if (!name.value || nameProblem.value) { formError.value = nameProblem.value || t("Enter a name."); return; }
  if (!editing.value && !value.value) { formError.value = t("Enter a value."); return; }
  saving.value = true;
  try {
    const body: Record<string, string> = { note: note.value };
    if (value.value) body.value = value.value;
    await api(`/secrets/${encodeURIComponent(name.value)}`, { method: "PUT", body: JSON.stringify(body) });
    emit("toast", editing.value ? t("Saved {name}.", { name: name.value }) : t("Added {name}.", { name: name.value }), "ok");
    open.value = false;
    value.value = "";
    await load();
  } catch (caught) {
    formError.value = errorText(caught);
  } finally {
    saving.value = false;
  }
}

async function remove(secret: Secret): Promise<void> {
  if (!confirm(t("Delete {name}? Scripts that read it will no longer find it.", { name: secret.name }))) return;
  try {
    await api(`/secrets/${encodeURIComponent(secret.name)}`, { method: "DELETE" });
    emit("toast", t("Deleted {name}.", { name: secret.name }), "ok");
    if (editing.value === secret.name) open.value = false;
    await load();
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  }
}

const example = computed(() => {
  const key = secrets.value[0]?.name ?? "API_TOKEN";
  return [
    `// JavaScript\nexport default { async fetch(request, env) { const token = env.${key}; } }`,
    `# Python\nimport os\ntoken = os.environ["${key}"]`,
    `// Go\ntoken := os.Getenv("${key}")`,
  ].join("\n\n");
});
</script>

<template>
  <div class="hd">
    <div>
      <span class="eyebrow">{{ t("Account") }}</span>
      <h1 class="serif">{{ t("Secrets") }}</h1>
      <p class="muted" style="margin: 12px 0 0; font-size: 15px; max-width: 560px">
        {{ t("Tokens and passwords your scripts need, kept out of the code. Every script job of this account gets them as environment variables.") }}
      </p>
    </div>
    <button type="button" class="btn primary" @click="startNew"><Icon name="plus" />{{ t("Add secret") }}</button>
  </div>

  <p v-if="error" class="alert" role="alert">{{ error }} <button type="button" class="btn sm" style="margin-left: 8px" @click="load()">{{ t("Retry") }}</button></p>

  <form v-if="open" class="card" @submit.prevent="save">
    <div class="sect">
      <h3 class="serif">{{ editing ? t("Edit {name}", { name: editing }) : t("New secret") }}</h3>
      <div class="grid2">
        <label class="fld">
          {{ t("Name") }}
          <input
            v-model.trim="name"
            class="in mono"
            :class="{ bad: nameProblem }"
            :disabled="!!editing"
            placeholder="API_TOKEN"
            autocomplete="off"
            spellcheck="false"
            maxlength="64"
            @input="name = name.toUpperCase()"
          />
          <small :class="{ err: nameProblem }">{{ nameProblem || t("Scripts read it under this name.") }}</small>
        </label>
        <label class="fld">
          {{ t("Note") }}
          <input v-model="note" class="in" maxlength="200" :placeholder="t('Optional: what it is for')" />
        </label>
      </div>
      <label class="fld">
        {{ t("Value") }}
        <textarea
          v-model="value"
          class="in mono value"
          rows="3"
          autocomplete="off"
          spellcheck="false"
          :placeholder="editing ? t('Leave empty to keep the current value') : ''"
        />
        <small>{{ t("Stored encrypted and never shown again. Run output that contains it is masked.") }}</small>
      </label>
      <p v-if="formError" class="alert" role="alert" style="margin: 0">{{ formError }}</p>
      <div style="display: flex; gap: 8px">
        <button type="submit" class="btn primary" :disabled="saving">{{ saving ? t("Saving…") : t("Save") }}</button>
        <button type="button" class="btn" @click="open = false">{{ t("Cancel") }}</button>
      </div>
    </div>
  </form>

  <div class="card">
    <div class="list">
      <div class="srow th"><span>{{ t("Name") }}</span><span>{{ t("Note") }}</span><span>{{ t("Updated") }}</span><span /></div>
      <div v-for="secret in secrets" :key="secret.name" class="srow">
        <span class="mono ellipsis" style="font-weight: 500">{{ secret.name }}</span>
        <span class="muted ellipsis">{{ secret.note ?? "" }}</span>
        <span class="mono faint" :title="shortDateTime(secret.updated_at)">{{ relative(secret.updated_at) }}</span>
        <span class="acts">
          <button type="button" class="btn sm" @click="startEdit(secret)"><Icon name="edit" />{{ t("Edit") }}</button>
          <button type="button" class="btn sm danger" :aria-label="t('Delete {name}', { name: secret.name })" @click="remove(secret)"><Icon name="trash" /></button>
        </span>
      </div>
      <p v-if="!loaded" class="muted empty">{{ t("Loading…") }}</p>
      <p v-else-if="!secrets.length && !error" class="muted empty">{{ t("No secrets yet.") }}</p>
    </div>
  </div>

  <div class="card sect">
    <h3 class="serif">{{ t("Reading a secret") }}</h3>
    <p class="muted" style="margin: 0; font-size: 14px">
      {{ t("Names are case-sensitive. A secret you change takes effect from the next run.") }}
    </p>
    <pre class="dark-pre">{{ example }}</pre>
  </div>
</template>

<style scoped>
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.value { height: auto; padding: 10px 14px; resize: vertical; line-height: 1.5; }
.list { padding: 6px 22px 10px; }
.srow { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(0, 1.4fr) 110px auto; gap: 14px; align-items: center; min-height: 52px; border-top: 1px solid var(--line); font-size: 14px; }
.srow.th { min-height: 36px; border-top: 0; }
.srow > span { min-width: 0; }
.acts { display: flex; gap: 6px; justify-content: flex-end; }
.empty { margin: 0; padding: 24px 0 16px; font-size: 14px; }
@media (max-width: 720px) {
  .grid2 { grid-template-columns: 1fr; }
  .srow.th { display: none; }
  .srow { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 12px 0; }
  .srow:nth-child(2) { border-top: 0; }
  .srow > :nth-child(2), .srow > :nth-child(3) { grid-column: 1; }
  .srow > .acts { grid-row: 1; grid-column: 2; }
}
</style>
