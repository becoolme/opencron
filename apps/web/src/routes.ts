export type Route =
  | { name: "jobs" }
  | { name: "runs" }
  | { name: "new" }
  | { name: "job"; id: number }
  | { name: "edit"; id: number };

/** Reads an app path with the language prefix already removed. */
export function parse(path: string): Route {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/runs") return { name: "runs" };
  if (clean === "/jobs/new") return { name: "new" };
  const edit = clean.match(/^\/jobs\/(\d+)\/edit$/);
  if (edit) return { name: "edit", id: Number(edit[1]) };
  const job = clean.match(/^\/jobs\/(\d+)$/);
  if (job) return { name: "job", id: Number(job[1]) };
  return { name: "jobs" };
}
