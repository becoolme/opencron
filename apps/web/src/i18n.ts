import { ref } from "vue";

export type Lang = "en" | "zh";

const STORAGE_KEY = "opencron-lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // storage blocked: fall through to the browser language
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function markDocument(next: Lang): void {
  if (typeof document !== "undefined") document.documentElement.lang = next === "zh" ? "zh-Hans" : "en";
}

export const lang = ref<Lang>(initialLang());
markDocument(lang.value);

export function setLang(next: Lang): void {
  lang.value = next;
  markDocument(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
}

/** Picks the string for the current language. Reactive inside templates and computed values. */
export function t(en: string, zh: string): string {
  return lang.value === "zh" ? zh : en;
}
