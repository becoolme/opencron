export type Route =
  | { name: "sign-in" }
  | { name: "sign-up" }
  | { name: "jobs" }
  | { name: "runs" }
  | { name: "secrets" }
  | { name: "keys" }
  | { name: "new" }
  | { name: "job"; id: number }
  | { name: "edit"; id: number }
  | { name: "missing" };

/** Where the app lives; the site's own pages (the landing page) sit outside it. */
export const APP_BASE = "/app";

/** Whether a path, with the language prefix already removed, belongs to the app. */
export function inApp(path: string): boolean {
  return path === APP_BASE || path.startsWith(`${APP_BASE}/`);
}

/** Reads an app path with the language prefix already removed: `/app/jobs/4` is job 4. */
export function parse(path: string): Route {
  const inside = inApp(path) ? path.slice(APP_BASE.length) : path;
  const clean = inside.replace(/\/+$/, "") || "/";
  if (clean === "/sign-in") return { name: "sign-in" };
  if (clean === "/sign-up") return { name: "sign-up" };
  if (clean === "/runs") return { name: "runs" };
  if (clean === "/secrets") return { name: "secrets" };
  if (clean === "/keys") return { name: "keys" };
  if (clean === "/jobs/new") return { name: "new" };
  const edit = clean.match(/^\/jobs\/(\d+)\/edit$/);
  if (edit) return { name: "edit", id: Number(edit[1]) };
  const job = clean.match(/^\/jobs\/(\d+)$/);
  if (job) return { name: "job", id: Number(job[1]) };
  return clean === "/" ? { name: "jobs" } : { name: "missing" };
}
