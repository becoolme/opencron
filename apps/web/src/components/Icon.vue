<script setup lang="ts">
const props = withDefaults(defineProps<{ name: keyof typeof PATHS; size?: number }>(), { size: 16 });
</script>

<script lang="ts">
const PATHS = {
  clock: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 7v5l3 2"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3.5 6h.01", "M3.5 12h.01", "M3.5 18h.01"],
  activity: ["M3 12h4l3-8l4 16l3-8h4"],
  plus: ["M12 5v14", "M5 12h14"],
  play: ["M7 5l12 7l-12 7z"],
  pause: ["M8 5v14", "M16 5v14"],
  edit: ["M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4", "M13.5 6.5l4 4"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14", "M20 20l-4-4"],
  alert: ["M12 3l9.5 17h-19z", "M12 10v4", "M12 17h.01"],
  back: ["M15 6l-6 6l6 6"],
  logout: ["M15 4h4v16h-4", "M10 8l-4 4l4 4", "M6 12h11"],
  bell: ["M6 16V11a6 6 0 0 1 12 0v5l2 2H4z", "M10 20h4"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  globe: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M3 12h18", "M12 3c3 3.5 3 14.5 0 18", "M12 3c-3 3.5-3 14.5 0 18"],
  code: ["M8 7l-5 5l5 5", "M16 7l5 5l-5 5"],
  shield: ["M12 3l8 3v6c0 4.5-3.5 8-8 9c-4.5-1-8-4.5-8-9V6z"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3", "M12 15v2"],
  key: ["M7.5 10.5a4 4 0 1 0 0 8a4 4 0 1 0 0-8", "M10.4 11.6L19 3", "M15.5 6.5l2.5 2.5", "M13.3 8.7l2 2"],
} as const;
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="d in PATHS[props.name]" :key="d" :d="d" />
  </svg>
</template>
