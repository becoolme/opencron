<script setup lang="ts">
// clock → run() → check, the line drawing from the design header.
defineProps<{ failed?: boolean }>();
</script>

<template>
  <svg class="art" width="300" height="116" viewBox="0 0 300 116" aria-hidden="true">
    <circle class="l" cx="46" cy="58" r="30" />
    <path class="l" d="M46 40v18l11 7" />
    <path class="l g" d="M46 22v4M46 90v4M10 58h4M78 58h4" />
    <path class="l a flow" d="M84 58h40" />
    <rect class="l" x="126" y="40" width="64" height="36" rx="9" />
    <text x="139" y="62" class="i">run()</text>
    <path class="l a flow" d="M192 58h40" />
    <circle class="l" :class="failed ? 'r' : 'k'" cx="258" cy="58" r="20" />
    <path v-if="!failed" class="l k" d="M249 58l6 6l11-12" />
    <path v-else class="l r" d="M251 51l14 14M265 51l-14 14" />
    <circle class="l pulse" :class="failed ? 'r' : 'k'" cx="258" cy="58" r="20" />
    <text x="20" y="112">cron</text>
    <text x="226" y="112">{{ failed ? "alert" : "2xx / exit 0" }}</text>
  </svg>
</template>
