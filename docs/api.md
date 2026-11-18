# API and MCP

Everything the web app does goes through a JSON API under `/api`. Scripts, CI and AI assistants can use the same API
with an API key, and MCP clients can connect to `/api/mcp`.

## API keys

Create keys on the **API & MCP** page of the app. A key looks like `oc_` followed by 32 characters. It is shown once,
when it is created; only a SHA-256 hash of it is stored, so a lost key cannot be recovered, only replaced.

Each key has one of two scopes:

| Scope | Can do |
| --- | --- |
| `read` | `GET` requests only: list jobs, runs and secret names. Any other method is refused with `403`. Jobs come back without credentials: header values, the request body, webhook URL paths, signing secrets and bot tokens read `***`. |
| `write` | Everything its creator can do in the app with their workspace role, except managing API keys, members and invitations. |

A workspace has at most 20 keys. A key works only in the workspace it was created in, with the role of the person who
created it, and stops working when they leave the workspace. A key can be limited to some projects of the workspace
(`project_ids`); see [workspaces.md](workspaces.md#api-keys-and-projects). Revoking a key on the API & MCP page refuses it at once. The page also shows when each key was last used
(recorded at most once a minute).

Send the key in either header:

```bash
curl -H "Authorization: Bearer oc_..." https://cron.example.com/api/jobs
curl -H "x-api-key: oc_..." https://cron.example.com/api/jobs
```

A missing, wrong or revoked key gets `401 {"error": "Invalid API key"}`. Errors are always JSON with an `error` string.

## Endpoints

Timestamps are Unix seconds. Every request runs in one workspace and can be narrowed to one project with the
`x-workspace-id` and `x-project-id` headers. [workspaces.md](workspaces.md#api) lists them with the workspace, project,
member and invitation endpoints.

### Meta

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/meta` | `{runtimes}`: the script runtimes this deployment offers (`javascript` on Cloudflare; `javascript`, `python` and `go` with Docker or with a sandbox next to Cloudflare). |

### Jobs

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/jobs` | `{jobs}`: every job of the workspace, or of the project picked with `x-project-id`. |
| `POST` | `/api/jobs` | Create a job; returns `201 {job}`. |
| `GET` | `/api/jobs/:id` | `{job}`, or `404`. |
| `PATCH` | `/api/jobs/:id` | Change the fields sent; the type cannot change. `{"enabled": false}` pauses a job. |
| `POST` | `/api/jobs/:id/run` | Run once now and wait for the result: `{result}`. The next scheduled run does not move. |
| `GET` | `/api/jobs/:id/executions` | That job's runs, newest first. |
| `DELETE` | `/api/jobs/:id` | Delete the job and its run history. |

Job fields:

| Field | |
| --- | --- |
| `name` | Required. A workspace has at most 200 jobs. |
| `type` | `url` (default) or `script`. |
| `cron` | Required. Five-field cron expression, in UTC. |
| `enabled` | Default `true`. |
| `timeout_ms` | 1000 to 60000. |
| `url`, `method`, `headers`, `body` | For `url` jobs. `method` is one of GET, POST, PUT, PATCH, DELETE, HEAD. |
| `script`, `runtime` | For `script` jobs. The script is at most 256 KB; `runtime` must be one `/api/meta` lists. See [scripts.md](scripts.md). |
| `project_id` | The project the job belongs to. Needed on create only when the workspace has more than one project and no `x-project-id` header is sent. Changing it moves the job. |
| `notify_targets` | Up to 10 alert targets for failed runs, scheduled or started by hand, or `null`. Each has a `type`: `http` (`url`, optional `headers`), `slack` or `discord` (`url`), `lark` or `dingtalk` (`url`, optional `sign_secret`), `telegram` (`bot_token`, `chat_id`). |

```bash
curl -X POST https://cron.example.com/api/jobs \
  -H "Authorization: Bearer oc_..." -H "content-type: application/json" \
  -d '{"name": "Ping", "cron": "*/5 * * * *", "url": "https://example.com/health"}'
```

### Runs

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/executions` | `{executions}`: runs of all jobs, newest first. |

Both run lists take `limit` (default 50, at most 200) and `before` (a `started_at` value, to page back).

### Secrets

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/secrets` | `{secrets}`: names, notes and when they were created and last changed. Values are never returned. |
| `PUT` | `/api/secrets/:name` | `{"value": "...", "note": "..."}` creates or replaces a secret. Without `value` it changes only the note of an existing one. |
| `DELETE` | `/api/secrets/:name` | Delete a secret. |

Names are upper case letters, digits and underscores, starting with a letter or underscore, at most 64 characters.
[scripts.md](scripts.md#secrets) covers the limits and how scripts read them.

### API keys

`GET`, `POST` and `DELETE /api/keys` exist for the app's own page and need a signed-in session. Requests with an API
key are refused with `403`, so a leaked key cannot create more keys.

## MCP

The MCP endpoint is `https://<your host>/api/mcp`, using the Streamable HTTP transport. Authenticate with an API key in
the `Authorization` header. A read key limits the assistant to reading: write tools come back as tool errors.

Claude Code:

```bash
claude mcp add --transport http opencron https://cron.example.com/api/mcp \
  --header "Authorization: Bearer oc_..."
```

Other clients:

```json
{
  "mcpServers": {
    "opencron": {
      "type": "http",
      "url": "https://cron.example.com/api/mcp",
      "headers": { "Authorization": "Bearer oc_..." }
    }
  }
}
```

The API & MCP page shows both snippets with your host filled in.

| Tool | Needs a write key | |
| --- | --- | --- |
| `get_meta` | | Script runtimes this deployment offers. |
| `list_jobs` | | Every job, with schedule and last result. |
| `get_job` | | One job's full configuration. |
| `create_job` | yes | Create a URL or script job. |
| `update_job` | yes | Change some fields of a job. |
| `pause_job`, `resume_job` | yes | Switch a job's schedule off or on. |
| `run_job` | yes | Run a job once now and return the result. |
| `delete_job` | yes | Delete a job and its history. |
| `list_job_executions` | | Recent runs of one job. |
| `list_executions` | | Recent runs of all jobs. |
| `list_secrets` | | Secret names and notes, never values. |
| `set_secret` | yes | Create or replace a secret. |
| `delete_secret` | yes | Delete a secret. |

Each tool call runs as an ordinary API request with the caller's key, so the scope, workspace and project rules above apply to
MCP in the same way.
