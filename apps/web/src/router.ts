import { ref } from "vue";
import { lang, localePath, markDocument, splitPath, type Locale } from "./i18n";

import { parse, type Route } from "./routes";

export type { Route };

// Links from the old hash router (`/#/jobs/4`) land on the same page.
if (location.hash.startsWith("#/")) {
  const { locale } = splitPath(location.pathname);
  history.replaceState(null, "", localePath(locale, location.hash.slice(1) || "/") + location.search);
}

export const route = ref<Route>(parse(splitPath(location.pathname).rest));

function sync(): void {
  const { locale, rest } = splitPath(location.pathname);
  lang.value = locale;
  markDocument();
  route.value = parse(rest);
}

window.addEventListener("popstate", sync);

let leaveGuard: (() => boolean) | null = null;

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
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.hash) return;
  event.preventDefault();
  go(url.pathname + url.search);
});

/** Addresses in the current language. Read inside templates or computed values to follow language changes. */
export const href = {
  get jobs() { return localePath(lang.value, "/"); },
  get runs() { return localePath(lang.value, "/runs"); },
  get newJob() { return localePath(lang.value, "/jobs/new"); },
  job: (id: number) => localePath(lang.value, `/jobs/${id}`),
  edit: (id: number) => localePath(lang.value, `/jobs/${id}/edit`),
};
