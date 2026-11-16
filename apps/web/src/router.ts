import { ref } from "vue";
import { lang, localePath, markDocument, splitPath, type Locale } from "./i18n";

import { APP_BASE, inApp, parse, type Route } from "./routes";

export type { Route };

// Links from the old hash router (`/#/jobs/4`) land on the same page.
if (location.hash.startsWith("#/")) {
  const { locale } = splitPath(location.pathname);
  history.replaceState(null, "", app(locale, location.hash.slice(1) || "/") + location.search);
}

/** An app address in a language: `/jobs/4` → `/ja/app/jobs/4`, `/` → `/ja/app`. */
function app(locale: Locale, path: string): string {
  return localePath(locale, path === "/" ? APP_BASE : `${APP_BASE}${path}`);
}

export const route = ref<Route>(parse(splitPath(location.pathname).rest));

/** The address the app shows, so a cancelled Back can put it back. */
let shown = location.pathname + location.search;

function sync(): void {
  const { locale, rest } = splitPath(location.pathname);
  lang.value = locale;
  markDocument();
  route.value = parse(rest);
  shown = location.pathname + location.search;
}

let leaveGuard: (() => boolean) | null = null;

// The browser has already changed the address when Back or Forward fires: a page that keeps its unsaved work
// restores the address it showed instead of rendering the one it is leaving for.
window.addEventListener("popstate", () => {
  if (leaveGuard && !leaveGuard()) {
    history.pushState(null, "", shown);
    return;
  }
  sync();
});

/** Lets a page with unsaved work confirm before an in-app navigation; returns the remover. */
export function guardLeave(guard: () => boolean): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

/** Opens an address produced by `href`. */
export function go(path: string): void {
  if (leaveGuard && !leaveGuard()) return;
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  sync();
  window.scrollTo(0, 0);
}

/** Shows the current page in another language. */
export function switchLocale(locale: Locale): void {
  const { rest } = splitPath(location.pathname);
  history.pushState(null, "", localePath(locale, rest) + location.search);
  sync();
}

// In-app links navigate without a page load; anything the browser should own is left alone.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
  const url = new URL(link.href);
  // The landing page and the other site pages are static: leaving the app is an ordinary page load.
  if (url.origin !== location.origin || !inApp(splitPath(url.pathname).rest) || url.hash) return;
  event.preventDefault();
  go(url.pathname + url.search);
});

/** Addresses in the current language. Read inside templates or computed values to follow language changes. */
export const href = {
  get jobs() { return app(lang.value, "/"); },
  get runs() { return app(lang.value, "/runs"); },
  get secrets() { return app(lang.value, "/secrets"); },
  get keys() { return app(lang.value, "/keys"); },
  get newJob() { return app(lang.value, "/jobs/new"); },
  job: (id: number) => app(lang.value, `/jobs/${id}`),
  edit: (id: number) => app(lang.value, `/jobs/${id}/edit`),
};
