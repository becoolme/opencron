<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { errorText, relative, shortDateTime } from "../format";
import { t } from "../i18n";
import { go, href } from "../router";
import { boot, canManage, reset, workspace } from "../store";
import type { WorkspaceRole } from "../types";
import Icon from "./Icon.vue";

interface Member { id: string; user_id: string; name: string; email: string; role: WorkspaceRole; created_at: string }
interface Invitation { id: string; email: string; role: WorkspaceRole; expires_at: string; created_at: string; invited_by: string | null; url: string }

const props = defineProps<{ userId: string }>();
const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail" | "info"] }>();

const members = ref<Member[]>([]);
const invitations = ref<Invitation[]>([]);
const loaded = ref(false);
const error = ref("");

const role = computed(() => workspace.value?.role ?? "member");
const isOwner = computed(() => role.value === "owner");
const ROLE_LABEL = computed<Record<WorkspaceRole, string>>(() => ({ owner: t("Owner"), admin: t("Admin"), member: t("Member") }));
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function load(): Promise<void> {
  error.value = "";
  try {
    const [list, pending] = await Promise.all([
      api<{ members: Member[] }>("/members"),
      canManage.value ? api<{ invitations: Invitation[] }>("/invitations") : Promise.resolve({ invitations: [] }),
    ]);
    members.value = list.members;
    invitations.value = pending.invitations;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

// Inviting: the API returns a link that the inviter sends themselves.
const open = ref(false);
const email = ref("");
const inviteRole = ref<"member" | "admin">("member");
const saving = ref(false);
const formError = ref("");
const created = ref<Invitation | null>(null);

function startInvite(): void {
  email.value = "";
  inviteRole.value = "member";
  formError.value = "";
  created.value = null;
  open.value = true;
}

async function invite(): Promise<void> {
  formError.value = "";
  if (!email.value.trim()) { formError.value = t("Enter an email address."); return; }
  saving.value = true;
  try {
    const result = await api<{ invitation: Invitation }>("/invitations", {
      method: "POST",
      body: JSON.stringify({ email: email.value.trim(), role: inviteRole.value }),
    });
    created.value = result.invitation;
    open.value = false;
    await load();
  } catch (caught) {
    formError.value = errorText(caught);
  } finally {
    saving.value = false;
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

async function withdraw(item: Invitation): Promise<void> {
  if (!confirm(t("Withdraw the invitation for {email}? The link stops working.", { email: item.email }))) return;
  try {
    await api(`/invitations/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (created.value?.id === item.id) created.value = null;
    emit("toast", t("Invitation withdrawn."), "ok");
    await load();
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  }
}

/** Admins cannot change owners or make someone owner; the API enforces the rest. */
function canChangeRole(member: Member): boolean {
  if (!canManage.value || member.user_id === props.userId) return false;
  return isOwner.value || member.role !== "owner";
}

function roleChoices(): WorkspaceRole[] {
  return isOwner.value ? ["owner", "admin", "member"] : ["admin", "member"];
}

async function changeRole(member: Member, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
  const next = select.value as WorkspaceRole;
  try {
    await api(`/members/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
    member.role = next;
    emit("toast", t("{name} is now {role}.", { name: member.name, role: ROLE_LABEL.value[next] }), "ok");
  } catch (caught) {
    select.value = member.role;
    emit("toast", errorText(caught), "fail");
  }
}

const ownerCount = computed(() => members.value.filter((member) => member.role === "owner").length);

/** The last owner can neither leave nor be removed; they delete the workspace or hand ownership on first. */
function canRemove(member: Member): boolean {
  if (member.role === "owner" && ownerCount.value === 1) return false;
  if (member.user_id === props.userId) return true;
  return canManage.value && (isOwner.value || member.role !== "owner");
}

async function remove(member: Member): Promise<void> {
  const self = member.user_id === props.userId;
  const question = self
    ? t("Leave {workspace}? You lose access to its jobs and secrets, and your API keys here stop working.", { workspace: workspace.value?.name ?? "" })
    : t("Remove {name} from this workspace? Their API keys here stop working.", { name: member.name });
  if (!confirm(question)) return;
  try {
    await api(`/members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
    if (self) {
      reset();
      await boot();
      emit("toast", t("You left the workspace."), "ok");
      go(href.jobs);
      return;
    }
    emit("toast", t("Removed {name}.", { name: member.name }), "ok");
    await load();
  } catch (caught) {
    emit("toast", errorText(caught), "fail");
  }
}
</script>

<template>
  <div class="hd">
    <div>
      <span class="eyebrow">{{ workspace?.name }}</span>
      <h1 class="serif">{{ t("Members") }}</h1>
      <p class="muted" style="margin: 12px 0 0; font-size: 15px; max-width: 600px">
        {{ t("Everyone here shares the workspace's jobs, runs and secrets. Owners and admins also manage members, projects and API keys.") }}
      </p>
    </div>
    <button v-if="canManage" type="button" class="btn primary" @click="startInvite"><Icon name="plus" />{{ t("Invite someone") }}</button>
  </div>

  <p v-if="error" class="alert" role="alert">{{ error }} <button type="button" class="btn sm" style="margin-left: 8px" @click="load()">{{ t("Retry") }}</button></p>

  <div v-if="created" class="card sect reveal" role="status">
    <h3 class="serif">{{ t("Send this link to {email}", { email: created.email }) }}</h3>
    <p class="muted" style="margin: 0; font-size: 14px">
      {{ t("OpenCron doesn't send email. The link works once, for that address only, until {when}.", { when: shortDateTime(seconds(created.expires_at)) }) }}
    </p>
    <div class="token">
      <code class="mono">{{ created.url }}</code>
      <button type="button" class="btn sm" @click="copy(created.url)"><Icon name="copy" />{{ t("Copy link") }}</button>
    </div>
    <div><button type="button" class="btn sm" @click="created = null">{{ t("Done") }}</button></div>
  </div>

  <form v-if="open" class="card" @submit.prevent="invite">
    <div class="sect">
      <h3 class="serif">{{ t("Invite someone") }}</h3>
      <label class="fld">
        {{ t("Email") }}
        <input v-model="email" type="email" class="in" maxlength="254" placeholder="name@example.com" autocomplete="off" />
        <small>{{ t("They sign in or sign up with this address to accept.") }}</small>
      </label>
      <div class="fld">
        {{ t("Role") }}
        <div class="seg" role="radiogroup" :aria-label="t('Role')">
          <button type="button" role="radio" :class="{ on: inviteRole === 'member' }" :aria-checked="inviteRole === 'member'" @click="inviteRole = 'member'">{{ t("Member") }}</button>
          <button type="button" role="radio" :class="{ on: inviteRole === 'admin' }" :aria-checked="inviteRole === 'admin'" @click="inviteRole = 'admin'">{{ t("Admin") }}</button>
        </div>
        <small>{{ inviteRole === "admin"
          ? t("Can also invite and remove members, manage projects and create API keys.")
          : t("Can create, edit, run and delete jobs, and set secrets.") }}</small>
      </div>
      <p v-if="formError" class="alert" role="alert" style="margin: 0">{{ formError }}</p>
      <div style="display: flex; gap: 8px">
        <button type="submit" class="btn primary" :disabled="saving">{{ saving ? t("Creating…") : t("Create invitation link") }}</button>
        <button type="button" class="btn" @click="open = false">{{ t("Cancel") }}</button>
      </div>
    </div>
  </form>

  <div class="card">
    <div class="list">
      <div class="mrow th"><span>{{ t("Name") }}</span><span>{{ t("Role") }}</span><span>{{ t("Joined") }}</span><span /></div>
      <div v-for="member in members" :key="member.id" class="mrow">
        <span class="who">
          <b class="ellipsis">{{ member.name }}<small v-if="member.user_id === userId" class="faint"> · {{ t("you") }}</small></b>
          <small class="faint ellipsis">{{ member.email }}</small>
        </span>
        <span>
          <select v-if="canChangeRole(member)" class="in role" :value="member.role" :aria-label="t('Role of {name}', { name: member.name })" @change="changeRole(member, $event)">
            <option v-for="choice in roleChoices()" :key="choice" :value="choice">{{ ROLE_LABEL[choice] }}</option>
          </select>
          <span v-else class="chip">{{ ROLE_LABEL[member.role] }}</span>
        </span>
        <span class="mono faint" :title="shortDateTime(seconds(member.created_at))">{{ relative(seconds(member.created_at)) }}</span>
        <span class="acts">
          <button v-if="canRemove(member)" type="button" class="btn sm danger" @click="remove(member)">
            {{ member.user_id === userId ? t("Leave") : t("Remove") }}
          </button>
        </span>
      </div>
      <p v-if="!loaded" class="muted empty">{{ t("Loading…") }}</p>
    </div>
  </div>

  <div v-if="canManage && invitations.length" class="card">
    <div class="list">
      <h3 class="serif" style="margin: 14px 0 6px">{{ t("Open invitations") }}</h3>
      <div v-for="item in invitations" :key="item.id" class="mrow">
        <span class="who">
          <b class="ellipsis">{{ item.email }}</b>
          <small v-if="item.invited_by" class="faint ellipsis">{{ t("Invited by {name}", { name: item.invited_by }) }}</small>
        </span>
        <span><span class="chip">{{ ROLE_LABEL[item.role] }}</span></span>
        <span class="mono faint" :title="shortDateTime(seconds(item.expires_at))">{{ t("Expires {when}", { when: relative(seconds(item.expires_at)) }) }}</span>
        <span class="acts">
          <button type="button" class="btn sm" @click="copy(item.url)"><Icon name="copy" />{{ t("Copy link") }}</button>
          <button type="button" class="btn sm danger" @click="withdraw(item)">{{ t("Withdraw") }}</button>
        </span>
      </div>
    </div>
  </div>

  <p class="faint note">
    {{ t("Scripts can read this workspace's secrets, so everyone who can edit jobs here can see them.") }}
  </p>
</template>

<style scoped>
.list { padding: 6px 22px 10px; }
.mrow { display: grid; grid-template-columns: minmax(160px, 1.6fr) 130px 120px auto; gap: 14px; align-items: center; min-height: 58px; border-top: 1px solid var(--line); font-size: 14px; }
.mrow.th { min-height: 36px; border-top: 0; }
.mrow > span { min-width: 0; }
.who { display: grid; line-height: 1.3; }
.who b { font-weight: 500; }
.role { height: 34px; font-size: 13.5px; padding-top: 0; padding-bottom: 0; }
.acts { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.empty { margin: 0; padding: 24px 0 16px; font-size: 14px; }
.token { display: flex; gap: 10px; align-items: center; padding: 10px 12px 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.token code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13.5px; }
.reveal { border-color: #b9d8c4; }
.note { margin: 0; font-size: 13px; }
@media (max-width: 720px) {
  .mrow.th { display: none; }
  .mrow { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; padding: 12px 0; }
  .mrow > :nth-child(2), .mrow > :nth-child(3) { grid-column: 1; }
  .mrow > .acts { grid-row: 1; grid-column: 2; }
}
</style>
