<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { errorText } from "../format";
import { t } from "../i18n";
import { go, href } from "../router";
import { boot, reset } from "../store";
import type { WorkspaceRole } from "../types";

interface Invite {
  id: string;
  workspace: { id: string; name: string };
  email: string;
  role: WorkspaceRole;
  invited_by: string | null;
  state: "pending" | "expired" | "used" | "wrong_account";
}

const props = defineProps<{ id: string; email: string }>();
const emit = defineEmits<{ toast: [text: string, kind?: "ok" | "fail" | "info"]; signOut: [] }>();

const invite = ref<Invite | null>(null);
const error = ref("");
const loading = ref(true);
const accepting = ref(false);

const ROLE_LABEL = computed<Record<WorkspaceRole, string>>(() => ({ owner: t("Owner"), admin: t("Admin"), member: t("Member") }));

onMounted(async () => {
  try {
    invite.value = (await api<{ invitation: Invite }>(`/invite/${encodeURIComponent(props.id)}`)).invitation;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
  }
});

async function accept(): Promise<void> {
  if (!invite.value) return;
  accepting.value = true;
  try {
    await api(`/invite/${encodeURIComponent(props.id)}/accept`, { method: "POST" });
    const name = invite.value.workspace.name;
    reset();
    await boot();
    emit("toast", t("You joined {workspace}.", { workspace: name }), "ok");
    go(href.jobs);
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    accepting.value = false;
  }
}
</script>

<template>
  <section class="card invite">
    <p v-if="loading" class="muted" style="margin: 0">{{ t("Loading…") }}</p>
    <template v-else-if="invite">
      <span class="eyebrow">{{ t("Invitation") }}</span>
      <h1 class="serif">{{ t("Join {workspace}", { workspace: invite.workspace.name }) }}</h1>
      <p class="muted">
        {{ invite.invited_by
          ? t("{name} invited {email} as {role}.", { name: invite.invited_by, email: invite.email, role: ROLE_LABEL[invite.role] })
          : t("{email} was invited as {role}.", { email: invite.email, role: ROLE_LABEL[invite.role] }) }}
      </p>

      <template v-if="invite.state === 'pending'">
        <p v-if="error" class="alert" role="alert">{{ error }}</p>
        <div class="row">
          <button type="button" class="btn primary" :disabled="accepting" @click="accept">{{ accepting ? t("Joining…") : t("Accept and join") }}</button>
          <a class="btn" :href="href.jobs">{{ t("Not now") }}</a>
        </div>
      </template>
      <template v-else-if="invite.state === 'wrong_account'">
        <p class="alert" role="alert">
          {{ t("This invitation is for {invited}, and you are signed in as {current}. Sign in with the invited address to accept it.", { invited: invite.email, current: email }) }}
        </p>
        <div class="row"><button type="button" class="btn" @click="emit('signOut')">{{ t("Sign out") }}</button></div>
      </template>
      <p v-else class="alert" role="alert">
        {{ invite.state === "expired" ? t("This invitation has expired. Ask for a new one.") : t("This invitation has already been used or was withdrawn.") }}
      </p>
    </template>
    <template v-else>
      <h1 class="serif">{{ t("Invitation not found") }}</h1>
      <p class="alert" role="alert">{{ error }}</p>
      <div class="row"><a class="btn" :href="href.jobs">{{ t("Back to your jobs") }}</a></div>
    </template>
  </section>
</template>

<style scoped>
.invite { max-width: 560px; padding: 32px; display: grid; gap: 14px; justify-items: start; }
.invite h1 { margin: 0; font-size: 34px; font-weight: 400; line-height: 1.1; overflow-wrap: anywhere; }
.invite p { margin: 0; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
