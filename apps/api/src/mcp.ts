import { createMcpServer, type Tool } from "@openuptime/mcp-rest";
import { mountMcp } from "@openuptime/mcp-rest/hono";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppHonoEnv } from "./types";

/**
 * Model Context Protocol server (Streamable HTTP, stateless, JSON responses) at POST /api/mcp. The protocol lives in
 * @openuptime/mcp-rest; this file is the OpenCron tool list. Every tool is a thin call into the REST API with the
 * caller's own credentials, so API-key scopes, validation and limits apply exactly as they do for any other client.
 */

const id = z.number().int().positive().describe("Job id, from list_jobs.");
const cron = z.string().min(1).max(100).describe("Five-field cron expression, evaluated in UTC, e.g. \"*/15 * * * *\".");
const timeout = z.number().int().min(1000).max(60000).describe("How long a run may take, in milliseconds (1000 to 60000). Defaults to 30000.");
const headers = z.record(z.string(), z.string()).describe("Request headers sent with the call.");
const runtime = z.enum(["javascript", "python", "go"]).describe("Script language. Only those that get_meta lists can run on this deployment.");
const channelIds = z.array(z.string().min(1)).max(20)
  .describe("Alert channel ids from list_channels that get this job's failures. Replaces the job's previous list; an empty list turns alerts off. Left out on create, the workspace's default channels are used.");
const page = {
  limit: z.number().int().min(1).max(200).optional().describe("Most runs to return, newest first."),
  before: z.number().int().positive().optional().describe("Only runs that started before this unix time in seconds, to page back."),
};
const query = (args: { limit?: number; before?: number }) => {
  const params = new URLSearchParams();
  if (args.limit) params.set("limit", String(args.limit));
  if (args.before) params.set("before", String(args.before));
  return params.size ? `?${params}` : "";
};
const secretName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).describe("Secret name: capital letters, digits and underscores, not starting with a digit.");

const createJob = z.object({
  name: z.string().trim().min(1).max(200).describe("Display name of the job."),
  type: z.enum(["url", "script"]).default("url").describe("url calls an HTTP endpoint; script runs code. Cannot change later."),
  cron,
  enabled: z.boolean().optional().describe("false creates the job paused. Defaults to true."),
  timeout_ms: timeout.optional(),
  url: z.string().url().optional().describe("For type url: the endpoint to call."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("For type url: HTTP method. Defaults to GET."),
  headers: headers.optional().describe("For type url: request headers."),
  body: z.string().optional().describe("For type url: request body, sent as is."),
  script: z.string().min(1).optional().describe("For type script: the source. JavaScript exports default { fetch(request, env) } and returns a Response; secrets arrive as env.NAME (Python os.environ, Go os.Getenv)."),
  runtime: runtime.optional().describe("For type script: the language. Defaults to javascript."),
  channel_ids: channelIds.optional(),
  project_id: z.string().min(1).optional().describe("Project to create the job in, from list_projects. Defaults to the project argument, or to the only project there is."),
});

const updateJob = z.object({
  id,
  name: z.string().trim().min(1).max(200).optional(),
  cron: cron.optional(),
  enabled: z.boolean().optional().describe("false pauses the job, true resumes it."),
  timeout_ms: timeout.optional(),
  url: z.string().url().optional().describe("Type url only."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("Type url only."),
  headers: headers.nullable().optional().describe("Type url only. Replaces all headers; null removes them."),
  body: z.string().nullable().optional().describe("Type url only. null removes the body."),
  script: z.string().min(1).optional().describe("Type script only: the new source."),
  runtime: runtime.optional().describe("Type script only."),
  channel_ids: channelIds.optional(),
  project_id: z.string().min(1).optional().describe("Move the job to this project of the same workspace."),
});

export const TOOLS: Tool[] = [
  { name: "list_workspaces", description: "List the workspaces this caller can use, with ids, names and the caller's role. Pass an id as the workspace argument of other tools; without it they use the current workspace (an API key always uses its own).", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/workspaces" }) },
  { name: "list_projects", description: "List the projects of the workspace. Pass an id as the project argument to limit other tools to that project, or as project_id when creating a job.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/projects" }) },
  { name: "get_meta", description: "Read what this OpenCron deployment can run: the script runtimes it offers. Call it before creating a script job in a language other than JavaScript.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/meta" }) },
  { name: "list_channels", description: "List the alert channels of the workspace: where failure alerts go (webhook, Slack, Discord, Telegram, Lark, DingTalk), with ids, names, whether each is enabled and a default for new jobs, and masked settings. Pass ids as channel_ids when creating or updating a job. Channels are created and changed in the app or with the REST API.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/channels" }) },
  { name: "list_jobs", description: "List every job of the workspace (or of the project, when one is given) with its id, type, schedule, enabled state, next run and last result. Use it to find a job id before reading or changing it.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/jobs" }) },
  { name: "get_job", description: "Read one job's full configuration, including its script source or HTTP request and the ids of its alert channels.", schema: z.object({ id }), readOnly: true, build: ({ id }) => ({ method: "GET", path: `/api/jobs/${id}` }) },
  { name: "create_job", description: "Create a scheduled job and return it. A url job calls an HTTP endpoint on the schedule; a script job runs code (see get_meta for the languages). It starts on its schedule right away unless enabled is false. Needs a write API key.", schema: createJob, build: (args) => ({ method: "POST", path: "/api/jobs", body: args }) },
  { name: "update_job", description: "Change a job. Send its id and only the fields to change; the type cannot change. Use pause_job or resume_job to only switch it off or on. Needs a write API key.", schema: updateJob, idempotent: true, build: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/jobs/${id}`, body: rest }) },
  { name: "pause_job", description: "Stop a job from running on its schedule, keeping its configuration and history. Needs a write API key.", schema: z.object({ id }), idempotent: true, build: ({ id }) => ({ method: "PATCH", path: `/api/jobs/${id}`, body: { enabled: false } }) },
  { name: "resume_job", description: "Let a paused job run on its schedule again. Needs a write API key.", schema: z.object({ id }), idempotent: true, build: ({ id }) => ({ method: "PATCH", path: `/api/jobs/${id}`, body: { enabled: true } }) },
  { name: "run_job", description: "Run a job once now, outside its schedule, wait for it to finish and return the result (status, duration, response snippet or error). It does not move the next scheduled run. A failed run sends the job's alerts. Needs a write API key.", schema: z.object({ id }), openWorld: true, build: ({ id }) => ({ method: "POST", path: `/api/jobs/${id}/run` }) },
  { name: "delete_job", description: "Delete a job and all of its run history. This cannot be undone. Needs a write API key.", schema: z.object({ id }), destructive: true, idempotent: true, build: ({ id }) => ({ method: "DELETE", path: `/api/jobs/${id}` }) },
  { name: "list_job_executions", description: "Read the recent runs of one job, newest first, with status, timing, HTTP status, response snippet and error. Use it to find out why a job failed.", schema: z.object({ id, ...page }), readOnly: true, build: ({ id, ...rest }) => ({ method: "GET", path: `/api/jobs/${id}/executions${query(rest)}` }) },
  { name: "list_executions", description: "Read the recent runs of all jobs of the workspace (or of the project), newest first.", schema: z.object(page), readOnly: true, build: (args) => ({ method: "GET", path: `/api/executions${query(args)}` }) },
  { name: "list_secrets", description: "List the names and notes of the workspace's secrets. Values are never returned.", schema: z.object({}), readOnly: true, build: () => ({ method: "GET", path: "/api/secrets" }) },
  { name: "set_secret", description: "Create a secret or replace its value. Script jobs read it as an environment variable from their next run on. The value is stored encrypted and cannot be read back. Needs a write API key from a workspace owner or admin.", schema: z.object({ name: secretName, value: z.string().min(1).describe("The secret value."), note: z.string().max(200).optional().describe("What it is for, shown on the Secrets page.") }), idempotent: true, build: ({ name, ...rest }) => ({ method: "PUT", path: `/api/secrets/${name}`, body: rest }) },
  { name: "delete_secret", description: "Delete a secret. Scripts that read it will no longer find it. Needs a write API key from a workspace owner or admin.", schema: z.object({ name: secretName }), destructive: true, idempotent: true, build: ({ name }) => ({ method: "DELETE", path: `/api/secrets/${name}` }) },
];

export const mcpServer = createMcpServer({
  info: { name: "opencron", version: "1.0.0" },
  instructions: "Manage scheduled jobs on OpenCron. Start with list_workspaces and list_projects when the caller may use more than one, then list_jobs to find job ids. Cron expressions are evaluated in UTC. A read API key can use only the read tools; changes need a write key.",
  tools: TOOLS,
  context: {
    shape: {
      workspace: z.string().min(1).optional().describe("Workspace id from list_workspaces. Omit to use the current workspace."),
      project: z.string().min(1).optional().describe("Project id from list_projects, to limit the call to one project. Omit for all projects."),
    },
    toHeaders: ({ workspace, project }): Record<string, string> => ({
      ...(typeof workspace === "string" ? { "x-workspace-id": workspace } : {}),
      ...(typeof project === "string" ? { "x-project-id": project } : {}),
    }),
  },
});

/** Mounts POST /api/mcp on the outer app, before the session-protected /api group. */
export function mountOpenCronMcp(app: Hono<AppHonoEnv>): void {
  mountMcp(app, {
    server: mcpServer,
    path: "/api/mcp",
    probePath: "/api/meta",
    credentialHeaders: ["authorization", "x-api-key", "cookie"],
    contextHeaders: ["x-workspace-id", "x-project-id"],
  });
}
