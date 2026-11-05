<script setup lang="ts">
import { computed, ref } from "vue";
import { authClient } from "../auth-client";

const emit = defineEmits<{
  authenticated: [];
}>();

const mode = ref<"sign-in" | "sign-up">("sign-in");
const name = ref("");
const email = ref("");
const password = ref("");
const confirmPassword = ref("");
const pending = ref(false);
const error = ref("");

const isSignUp = computed(() => mode.value === "sign-up");

function switchMode(nextMode: "sign-in" | "sign-up"): void {
  mode.value = nextMode;
  error.value = "";
  password.value = "";
  confirmPassword.value = "";
}

async function submit(): Promise<void> {
  error.value = "";

  if (isSignUp.value && !name.value.trim()) {
    error.value = "Name is required.";
    return;
  }
  if (password.value.length < 8) {
    error.value = "Password must contain at least 8 characters.";
    return;
  }
  if (isSignUp.value && password.value !== confirmPassword.value) {
    error.value = "Passwords do not match.";
    return;
  }

  pending.value = true;
  try {
    const result = isSignUp.value
      ? await authClient.signUp.email({
          name: name.value.trim(),
          email: email.value.trim(),
          password: password.value,
        })
      : await authClient.signIn.email({
          email: email.value.trim(),
          password: password.value,
        });

    if (result.error) {
      error.value = result.error.message ?? "Authentication failed.";
      return;
    }

    emit("authenticated");
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "Authentication failed.";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <main class="min-h-screen flex items-center justify-center p-6">
    <section class="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-sm p-7 space-y-6">
      <header class="text-center space-y-2">
        <h1 class="text-2xl font-semibold text-slate-950">OpenCron</h1>
        <p class="text-sm text-slate-500">Schedule URL requests and isolated Worker scripts.</p>
      </header>

      <div class="grid grid-cols-2 bg-slate-100 rounded-lg p-1 text-sm">
        <button
          type="button"
          class="rounded-md px-3 py-2"
          :class="mode === 'sign-in' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'"
          @click="switchMode('sign-in')"
        >
          Sign in
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-2"
          :class="mode === 'sign-up' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'"
          @click="switchMode('sign-up')"
        >
          Create account
        </button>
      </div>

      <form class="space-y-4" @submit.prevent="submit">
        <label v-if="isSignUp" class="block text-sm">
          Name
          <input
            v-model="name"
            name="name"
            autocomplete="name"
            required
            class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
          />
        </label>
        <label class="block text-sm">
          Email
          <input
            v-model="email"
            type="email"
            name="email"
            autocomplete="email"
            required
            class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
          />
        </label>
        <label class="block text-sm">
          Password
          <input
            v-model="password"
            type="password"
            name="password"
            :autocomplete="isSignUp ? 'new-password' : 'current-password'"
            minlength="8"
            required
            class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
          />
        </label>
        <label v-if="isSignUp" class="block text-sm">
          Confirm password
          <input
            v-model="confirmPassword"
            type="password"
            name="confirm-password"
            autocomplete="new-password"
            minlength="8"
            required
            class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
          />
        </label>

        <p v-if="error" role="alert" class="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {{ error }}
        </p>

        <button
          type="submit"
          :disabled="pending"
          class="w-full bg-slate-900 text-white rounded-lg px-4 py-2.5 hover:bg-slate-700 disabled:cursor-wait disabled:opacity-60"
        >
          {{ pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in" }}
        </button>
      </form>
    </section>
  </main>
</template>
