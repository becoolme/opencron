import { localePath, splitPath } from "./i18n";
import { APP_BASE, inApp, parse } from "./routes";

const ORIGIN = "https://opencron.invalid";

export function isAuthRoute(name: string): boolean {
  return name === "sign-in" || name === "sign-up";
}

/** Only local app destinations can be used after authentication. */
export function returnDestination(path: string): string {
  const current = new URL(path, ORIGIN);
  const fallback = localePath(splitPath(current.pathname).locale, APP_BASE);
  const target = current.searchParams.get("returnTo");
  if (!target?.startsWith("/") || target.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(target)) return fallback;
  const url = new URL(target, ORIGIN);
  const { rest } = splitPath(url.pathname);
  if (url.origin !== ORIGIN || !inApp(rest) || isAuthRoute(parse(rest).name)) return fallback;
  return url.pathname + url.search + url.hash;
}

/** Switching between login and registration keeps the original destination. */
export function authPath(path: string, mode: "sign-in" | "sign-up"): string {
  const current = new URL(path, ORIGIN);
  const { locale, rest } = splitPath(current.pathname);
  const destination = isAuthRoute(parse(rest).name) ? returnDestination(path) : path;
  const auth = localePath(locale, `${APP_BASE}/${mode}`);
  return destination === localePath(locale, APP_BASE) ? auth : `${auth}?returnTo=${encodeURIComponent(destination)}`;
}

export function authRedirect(path: string, authenticated: boolean): string | null {
  const { rest } = splitPath(new URL(path, ORIGIN).pathname);
  const auth = isAuthRoute(parse(rest).name);
  if (authenticated) return auth ? returnDestination(path) : null;
  return auth ? null : authPath(path, "sign-in");
}
