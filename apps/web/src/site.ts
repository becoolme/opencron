import { localePath, type Locale } from "./i18n";
import { APP_BASE } from "./routes";

/** The static pages: each one is built once per language. English has no prefix. */
export const SITE_LOCALES: Locale[] = ["en", "zh-CN", "ja", "ko"];

/** The URL segment of each language that has one, for `pages/[locale]/`. */
export const LOCALE_SEGMENT: Record<Exclude<Locale, "en">, string> = { "zh-CN": "zh-Hans", ja: "ja", ko: "ko" };

export const HTML_LANG: Record<Locale, string> = { en: "en", "zh-CN": "zh-Hans", ja: "ja", ko: "ko" };
export const OG_LOCALE: Record<Locale, string> = { en: "en_US", "zh-CN": "zh_CN", ja: "ja_JP", ko: "ko_KR" };

export const REPO = "https://github.com/becoolme/opencron";
export const docs = (page: string) => `${REPO}/blob/main/docs/${page}`;

/** `getStaticPaths` for `pages/[locale]/`: every language except English. */
export function localeParams() {
  return (Object.entries(LOCALE_SEGMENT) as [Locale, string][]).map(([locale, segment]) => ({
    params: { locale: segment },
    props: { locale },
  }));
}

export const landingPath = (locale: Locale) => localePath(locale, "/");
export const appPath = (locale: Locale) => localePath(locale, APP_BASE);
