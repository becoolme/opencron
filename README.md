# OpenCron

Scheduled HTTP calls and script jobs, with run history and failure alerts. Runs on Cloudflare Workers or with Docker.

- **HTTP jobs** call a URL on a cron schedule and record the status, duration and the start of the response. Private
  and internal addresses are refused unless you allow them.
- **Script jobs** run your own code on a schedule:
  - on Cloudflare, JavaScript in an isolated Dynamic Worker with a per-job table store, D1 facade and KV namespace;
  - with Docker, Node.js, Python or Go in a fresh locked-down container per run, with no network by default;
  - a Cloudflare deployment can add Python and Go by pointing at a sandbox on a server of your own.

  See [docs/scripts.md](docs/scripts.md), [docs/docker.md](docs/docker.md) and
  [docs/deploy.md](docs/deploy.md#python-and-go-on-cloudflare).
- **Alert channels**: set up Slack, Discord, Telegram, Lark, DingTalk or any HTTP endpoint once, pick them on each job,
  and mark defaults for new jobs. See [docs/alerts.md](docs/alerts.md).
- **Accounts** with email and password. `SIGNUP=closed` lets only the first account, and people with an invitation,
  sign up.
- **Secrets** per workspace, passed to script jobs as environment variables and masked in run output.
- **Workspaces, projects and members**: share jobs and secrets with a team, with owner, admin and member roles and
  invitation links. See [docs/workspaces.md](docs/workspaces.md).
- **API keys, REST API and MCP** for scripts, CI and AI assistants, read-only or read-write. See [docs/api.md](docs/api.md).
- **Languages**: the site and the app are in English, 简体中文, 日本語 and 한국어.

On Cloudflare, one Worker serves the API, the web app and the every-minute scheduler, with the data in D1 or Postgres.
With Docker, the same app runs on Node with Postgres and a script sandbox.

## Self-host with Docker

```bash
cp .env.docker.example .env      # replace every change-me value: openssl rand -hex 32
docker compose up -d --build
```

Open `http://localhost:8080` and create the first account. [docs/docker.md](docs/docker.md) covers the containers,
runtimes, upgrades and backups.

## Deploy to Cloudflare

[docs/deploy.md](docs/deploy.md) walks through deploying to your own Cloudflare account, and
[docs/database.md](docs/database.md) covers using Postgres instead of D1.

## Develop

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set BETTER_AUTH_SECRET
pnpm db:init:local && pnpm db:migrate:local:0002 && pnpm db:migrate:local:0003 \
  && pnpm db:migrate:local:0004 && pnpm db:migrate:local:0005 && pnpm db:migrate:local:0006 && pnpm db:migrate:local:0007 \
  && pnpm db:migrate:local:0008 && pnpm db:migrate:local:0009 && pnpm db:migrate:local:0010 && pnpm db:migrate:local:0011
pnpm dev                                           # http://localhost:5173
```

You need Node 22+ and pnpm. [docs/development.md](docs/development.md) covers debugging, the scheduler and the checks
to run before a commit (`pnpm test`, `pnpm typecheck`).

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | The Worker and Node server: Hono API, Better Auth, scheduler, job runners, notifiers, migrations |
| `apps/web` | The static site built by Astro: the landing page at `/` and the Vue app at `/app` |
| `apps/sandbox` | The Docker script sandbox: runs Node.js, Python and Go jobs in one container per run |
| `packages/kit`, `packages/mcp-rest` | Shared with [OpenUptime](https://github.com/becoolme/openuptime), copied in by `pnpm sync:openuptime`; do not edit here |

## License

[MIT](LICENSE)
