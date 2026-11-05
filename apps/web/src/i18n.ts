import { ref } from "vue";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { zh } from "./locales/zh";

/** The same languages and URL prefixes as OpenUptime: English at `/`, the others under their own path. */
export type Locale = "en" | "zh-CN" | "ja" | "ko";

export const LOCALES: Record<Locale, string> = { en: "English", "zh-CN": "简体中文", ja: "日本語", ko: "한국어" };

const PREFIX: Record<Locale, string> = { en: "", "zh-CN": "/zh-Hans", ja: "/ja", ko: "/ko" };
const HTML_LANG: Record<Locale, string> = { en: "en", "zh-CN": "zh-Hans", ja: "ja", ko: "ko" };
const DICTIONARIES: Record<Locale, Record<string, string> | undefined> = { en: undefined, "zh-CN": zh, ja, ko };

/** Splits the language prefix off a path: `/zh-Hans/jobs/4` → zh-CN and `/jobs/4`. No prefix is English. */
export function splitPath(pathname: string): { locale: Locale; rest: string } {
  for (const locale of Object.keys(PREFIX) as Locale[]) {
    const prefix = PREFIX[locale];
    if (!prefix) continue;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return { locale, rest: pathname.slice(prefix.length) || "/" };
  }
  return { locale: "en", rest: pathname || "/" };
}

/** The address of an app path in a language: `/jobs` → `/ja/jobs`, `/` → `/ja`. */
export function localePath(locale: Locale, rest: string): string {
  const prefix = PREFIX[locale];
  if (!prefix) return rest;
  return rest === "/" ? prefix : `${prefix}${rest}`;
}

export const lang = ref<Locale>(typeof location === "undefined" ? "en" : splitPath(location.pathname).locale);

export function markDocument(): void {
  if (typeof document !== "undefined") document.documentElement.lang = HTML_LANG[lang.value];
}
markDocument();

/** BCP 47 tag for dates and relative times. */
export function intlLocale(): string {
  return lang.value === "en" ? "en-GB" : lang.value === "zh-CN" ? "zh-CN" : lang.value === "ja" ? "ja-JP" : "ko-KR";
}

/**
 * English text is the key; a language without an entry falls back to English.
 * `{name}` placeholders are filled from `vars`. Reactive inside templates and computed values.
 */
export function t(en: string, vars?: Record<string, string | number>): string {
  const text = DICTIONARIES[lang.value]?.[en] ?? en;
  return vars ? text.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m)) : text;
}
