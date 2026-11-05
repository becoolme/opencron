<script setup lang="ts">
import { computed, ref } from "vue";
import { authClient } from "../auth-client";
import { t } from "../i18n";
import LangSwitch from "./LangSwitch.vue";
import HeaderArt from "./HeaderArt.vue";
import Icon from "./Icon.vue";

const emit = defineEmits<{ authenticated: [] }>();

const mode = ref<"sign-in" | "sign-up">("sign-in");
const name = ref("");
const email = ref("");
const password = ref("");
const confirmPassword = ref("");
const pending = ref(false);
const error = ref("");

const isSignUp = computed(() => mode.value === "sign-up");

function switchMode(next: "sign-in" | "sign-up"): void {
  mode.value = next;
  error.value = "";
  password.value = "";
  confirmPassword.value = "";
}

async function submit(): Promise<void> {
  error.value = "";
  if (isSignUp.value && !name.value.trim()) {
    error.value = t("Enter your name.");
    return;
  }
  if (password.value.length < 8) {
    error.value = t("The password needs at least 8 characters.");
    return;
  }
  if (isSignUp.value && password.value !== confirmPassword.value) {
    error.value = t("The passwords don't match.");
    return;
  }

  pending.value = true;
  try {
    const result = isSignUp.value
      ? await authClient.signUp.email({ name: name.value.trim(), email: email.value.trim(), password: password.value })
      : await authClient.signIn.email({ email: email.value.trim(), password: password.value });
    if (result.error) {
      error.value = result.error.message ?? t("Sign-in failed.");
      return;
    }
    emit("authenticated");
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : t("Sign-in failed.");
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <main class="auth">
    <div class="auth-top">
      <span class="logo"><span class="mark"><Icon name="clock" :size="18" /></span>OpenCron</span>
      <LangSwitch />
    </div>

    <section class="card panel">
      <HeaderArt class="panel-art" />
      <h1 class="serif">{{ isSignUp ? t("Create your account") : t("Welcome back") }}</h1>
      <p class="muted" style="margin: 0 0 22px; font-size: 14.5px">
        {{ t("Schedule HTTP calls and sandboxed scripts with cron.") }}
      </p>

      <div class="seg tabs" role="tablist">
        <button type="button" role="tab" :class="{ on: !isSignUp }" :aria-selected="!isSignUp" @click="switchMode('sign-in')">{{ t("Sign in") }}</button>
        <button type="button" role="tab" :class="{ on: isSignUp }" :aria-selected="isSignUp" @click="switchMode('sign-up')">{{ t("Sign up") }}</button>
      </div>

      <form class="fields" @submit.prevent="submit">
        <label v-if="isSignUp" class="fld">
          <span>{{ t("Your name") }}</span>
          <input v-model="name" class="in" name="name" autocomplete="name" required />
        </label>
        <label class="fld">
          <span>{{ t("Email") }}</span>
          <input v-model="email" class="in" type="email" name="email" autocomplete="email" required />
        </label>
        <label class="fld">
          <span>{{ t("Password") }}</span>
          <input v-model="password" class="in" type="password" name="password" :autocomplete="isSignUp ? 'new-password' : 'current-password'" minlength="8" required />
          <small v-if="isSignUp">{{ t("At least 8 characters.") }}</small>
        </label>
        <label v-if="isSignUp" class="fld">
          <span>{{ t("Confirm password") }}</span>
          <input v-model="confirmPassword" class="in" type="password" name="confirm-password" autocomplete="new-password" minlength="8" required />
        </label>

        <p v-if="error" role="alert" class="alert" style="margin: 0">{{ error }}</p>

        <button type="submit" class="btn primary submit" :disabled="pending">
          {{ pending ? t("One moment…") : isSignUp ? t("Create account") : t("Sign in") }}
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.auth { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 20px 16px 48px; background: var(--surface); }
.auth-top { width: 100%; max-width: 1100px; display: flex; justify-content: space-between; align-items: center; margin-bottom: clamp(24px, 8vh, 80px); }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; }
.mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); display: grid; place-items: center; color: #fff; }
.panel { width: 100%; max-width: 420px; padding: 32px; }
.panel-art { width: 100%; height: auto; max-width: 260px; margin: -6px 0 12px; }
.panel h1 { margin: 0 0 8px; font-size: 34px; font-weight: 400; }
.tabs { display: grid; grid-template-columns: 1fr 1fr; margin-bottom: 20px; }
.fields { display: grid; gap: 16px; }
.submit { width: 100%; justify-content: center; height: 46px; }
@media (max-width: 480px) {
  .panel { padding: 24px 18px; }
}
</style>
