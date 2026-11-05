import { ref } from "vue";

export type Route =
  | { name: "jobs" }
  | { name: "runs" }
  | { name: "new" }
  | { name: "job"; id: number }
  | { name: "edit"; id: number };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/runs") return { name: "runs" };
  if (path === "/jobs/new") return { name: "new" };
  const edit = path.match(/^\/jobs\/(\d+)\/edit$/);
  if (edit) return { name: "edit", id: Number(edit[1]) };
  const job = path.match(/^\/jobs\/(\d+)$/);
  if (job) return { name: "job", id: Number(job[1]) };
  return { name: "jobs" };
}

export const route = ref<Route>(parse(location.hash));

window.addEventListener("hashchange", () => {
  route.value = parse(location.hash);
  window.scrollTo(0, 0);
});

export function go(path: string): void {
  location.hash = path;
}

export const href = {
  jobs: "#/",
  runs: "#/runs",
  newJob: "#/jobs/new",
  job: (id: number) => `#/jobs/${id}`,
  edit: (id: number) => `#/jobs/${id}/edit`,
};
