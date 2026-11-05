# OpenCron

Scheduled HTTP calls and script jobs, with run history and failure alerts. Runs on Cloudflare Workers or with Docker.

- **HTTP jobs** call a URL on a cron schedule and record the status, duration and the start of the response.
- **Script jobs** run your own JavaScript in an isolated Dynamic Worker on Cloudflare, with a per-job table store, D1
  facade and KV namespace; with Docker, Node.js, Python and Go scripts run in a locked-down container each. See
  [docs/scripts.md](docs/scripts.md) and [docs/docker.md](docs/docker.md).
- **Alerts** go to Slack, Discord, Telegram, Lark, DingTalk or any HTTP endpoint (optionally HMAC-signed) when a run
  fails.
- **Accounts** with email and password; every job and its storage belong to one user.

On Cloudflare, one Worker serves the API, the web app and the every-minute scheduler, with the data in D1 or Postgres.
To self-host instead, `docker compose up` runs the same app on Node with Postgres and a script sandbox
([docs/docker.md](docs/docker.md)).

## Quick start

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set BETTER_AUTH_SECRET
pnpm db:init:local && pnpm db:migrate:local:0002 && pnpm db:migrate:local:0003 \
  && pnpm db:migrate:local:0004 && pnpm db:migrate:local:0005 && pnpm db:migrate:local:0006 && pnpm db:migrate:local:0007
pnpm dev                                           # http://localhost:5173
```

You need Node 22+ and pnpm. [docs/development.md](docs/development.md) covers debugging and the scheduler,
[docs/deploy.md](docs/deploy.md) deploying to your own Cloudflare account and [docs/database.md](docs/database.md)
the Postgres option.

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | The Worker: Hono API, Better Auth, scheduler, job runners, notifiers, migrations |
| `apps/web` | The Vue web app, built by Vite and served as the Worker's static assets |
| `apps/sandbox` | The Docker script sandbox: runs Node.js, Python and Go jobs in one container per run |
| `packages/kit`, `packages/mcp-rest` | Shared with [OpenUptime](https://github.com/becoolme/openuptime), copied in by `pnpm sync:openuptime`; do not edit here |

## Editions

This repository is the open-source edition and runs on your own Cloudflare account or with Docker. The hosted service at
opencron.app is built from it plus a private branch with billing and the production configuration.

## License

[MIT](LICENSE)
