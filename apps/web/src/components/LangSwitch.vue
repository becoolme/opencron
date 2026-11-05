<script setup lang="ts">
import { LOCALES, lang, t, type Locale } from "../i18n";
import { switchLocale } from "../router";

const options = Object.entries(LOCALES) as [Locale, string][];
</script>

<template>
  <select
    class="lang-switch"
    :aria-label="t('Language')"
    :value="lang"
    @change="switchLocale(($event.target as HTMLSelectElement).value as Locale)"
  >
    <option v-for="[code, name] in options" :key="code" :value="code" :lang="code">{{ name }}</option>
  </select>
</template>

<style scoped>
.lang-switch {
  height: 30px;
  padding: 0 26px 0 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 9px center;
  appearance: none;
  font: 13px var(--sans);
  color: var(--ink);
  cursor: pointer;
}
.lang-switch:focus-visible { outline: 2px solid var(--accent, #2b6cb0); outline-offset: 1px; }
</style>
