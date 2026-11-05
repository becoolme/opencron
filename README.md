# OpenCron

Scheduled HTTP calls and JavaScript jobs on Cloudflare Workers, with run history and failure alerts.

- **HTTP jobs** call a URL on a cron schedule and record the status, duration and the start of the response.
- **Script jobs** run your own JavaScript in an isolated Dynamic Worker, with a per-job table store, D1 facade and KV
  namespace. See [docs/scripts.md](docs/scripts.md).
- **Alerts** go to Slack, Discord, Telegram, Lark, DingTalk or any HTTP endpoint (optionally HMAC-signed) when a run
  fails.
- **Accounts** with email and password; every job and its storage belong to one user.

OpenCron is built for Cloudflare: one Worker serves the API, the web app and the every-minute scheduler. The data lives
in D1 by default, or in Postgres.

## Quick start

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set BETTER_AUTH_SECRET
pnpm db:init:local && pnpm db:migrate:local:0002 && pnpm db:migrate:local:0003 \
  && pnpm db:migrate:local:0004 && pnpm db:migrate:local:0005 && pnpm db:migrate:local:0006
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
| `packages/kit`, `packages/mcp-rest` | Shared with [OpenUptime](https://github.com/becoolme/openuptime), copied in by `pnpm sync:openuptime`; do not edit here |

## Editions

This repository is the open-source edition and runs anywhere you can deploy a Cloudflare Worker. The hosted service at
opencron.app is built from it plus a private branch with billing and the production configuration.

## License

[MIT](LICENSE)
