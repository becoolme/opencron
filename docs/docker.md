# Self-host with Docker

`docker-compose.yml` runs OpenCron on your own machine or server as four containers:

| Service | What it does | Networks |
| --- | --- | --- |
| `app` | The web app, the API and the every-minute scheduler, in one Node process | default (published port) and internal |
| `postgres` | The database | internal only |
| `sandbox` | Runs script jobs in Node.js, Python or Go, one fresh container per run | internal and docker-api |
| `docker-guard` | The only service with the Docker socket; passes on just the calls the sandbox needs | docker-api only |

## Start it

```bash
cp .env.docker.example .env      # replace every change-me value: openssl rand -hex 32
docker compose up -d --build
```

Open `http://localhost:8080` (or `APP_URL`) and create an account. Only that first account can sign up: further
sign-ups are refused unless you set `SIGNUP=open` (see [Who can sign up](#who-can-sign-up)). The app applies the database migrations when it
starts. The sandbox pulls its three runtime images on first start, which takes a minute or two.

Run **one** `app` container: it runs the scheduler, and two of them would run every job twice.

Upgrade with `git pull && docker compose up -d --build`. Back up the `postgres-data` volume (or `pg_dump`) like any
other Postgres database.

## Script runtimes

On Docker, script jobs can be written in:

| Runtime | Image (default) | How it runs |
| --- | --- | --- |
| JavaScript | `node:22-alpine`, pinned by digest | An ES module. `export default { fetch(request, env, ctx) }` as on Cloudflare, or a default function that receives the run context. |
| Python | `python:3.12-alpine`, pinned by digest | `python3 main.py`. Standard library only. |
| Go | `golang:1.23-alpine`, pinned by digest | `go run main.go` in `package main`. Standard library only; the first run of a job includes compile time. |

Every runtime gets the run context (`jobId`, `jobName`, `scheduledAt`, `invocation`) as JSON in the `OPENCRON_CONTEXT`
environment variable; JavaScript also gets it as the request body. Python and Go runs succeed when the program exits
with code 0, and JavaScript runs when the response is 2xx. The start of stdout is kept with the run, and the end of
stderr becomes the error of a failed run.

The per-job KV, table store and D1 facade from [scripts.md](scripts.md) exist on Cloudflare only; Docker scripts get an
empty `env`.

## How scripts are isolated

The `sandbox` service starts each run with `docker run` and these limits:

- no network at all (`--network none`), so no access to the internet, the database or the app;
- a read-only root file system; the only writable place is a `/tmp` tmpfs (256 MB, 512 MB for Go), which cannot hold
  executables except for Go, whose compiler needs it;
- a non-root user (`65534`), every Linux capability dropped, `no-new-privileges`;
- 512 MB of memory without swap (1 GB for Go), one CPU, 64 processes, 256 open files; Go builds and runs with
  `GOFLAGS=-p=1` and `GOMAXPROCS=1` so that its compiler, which otherwise starts a worker per host CPU, stays within
  them;
- no volumes, no Docker socket, no environment from the host; the image is never pulled at run time;
- the account's [secrets](scripts.md#secrets) as environment variables, passed to `docker run` by name (`--env NAME`)
  so their values never appear on its command line; names the runtimes rely on are refused, so a secret cannot change
  `PATH`, `LD_PRELOAD` or the harness settings;
- killed once the job's timeout passes (Go gets 30 seconds on top for compiling, the others 2 seconds); the container is
  removed afterwards.

The app calls the sandbox with a shared `SANDBOX_TOKEN`. The sandbox refuses sources over 512 KB, keeps at most 64 KB of
each output stream, and runs `SANDBOX_CONCURRENCY` scripts at a time (4 by default); further runs queue, up to eight
per slot. One account holds at most `SANDBOX_OWNER_CONCURRENCY` of those slots (half of them by default) and its own
share of the queue, so one busy account cannot keep everyone else's scripts waiting.

The runtime images are pinned by digest in `apps/sandbox/src/docker-args.mjs`, so a re-pushed tag never changes what
runs. If you set `SANDBOX_IMAGE_*` yourself, pin those too (`name:tag@sha256:...`).

### The Docker socket and the guard

Starting a container needs the Docker socket, and **access to that socket is root on the host**. The sandbox therefore
does not get it. Only `docker-guard` mounts it, and the sandbox talks to the guard over an internal network
(`DOCKER_HOST=tcp://docker-guard:2375`). The guard passes on only:

- ping and version, and image inspect and pull for the three configured images;
- container create for a container named `opencron-run-<16 hex>`, with the body rebuilt from the few fields a run
  needs: the configured image and network, user `65534`, at most 1 GB of memory without swap, one CPU, 64 processes,
  a size-limited `/tmp`, and the hardening above forced on whatever the request said;
- attach, start, wait, inspect, kill and remove, for containers the guard created itself.

Everything else is refused with 403: listing containers, privileged containers, volumes and binds, host networking,
added capabilities, other images, and calls to any container the sandbox did not start. So even if someone took over
the sandbox process, they could only start more run containers like the ones above. The guard refuses to start if
`SANDBOX_NETWORK` is `host` or another container's network.

Scripts never reach the guard: they run with no network.

### Who can sign up

Every account can run scripts on your Docker host, so the Docker setup allows only the first account by default
(`SIGNUP=closed`): whoever opens the app first creates it, and later sign-ups are refused. Set `SIGNUP=open` only if
you trust everyone who can reach `APP_URL`.

### Untrusted users

The limits above stop scripts from reaching the network, the host's files or other containers. They still share the
host's Linux kernel, so a kernel bug could let a script out. If people you do not trust can run scripts:

- install [gVisor](https://gvisor.dev/docs/user_guide/install/) and set `SANDBOX_DOCKER_RUNTIME=runsc`, so scripts run
  against a user-space kernel instead of the host's (recommended);
- or run Docker in [rootless mode](https://docs.docker.com/engine/security/rootless/), so the socket is not root;
- keep the Docker host itself up to date, and do not run other important workloads on it.

To add Python and Go to a deployment on Cloudflare, run only the sandbox with `docker-compose.sandbox.yml`; see
[deploy.md](deploy.md#python-and-go-on-cloudflare).

If you do not need Python or Go, remove the `sandbox` service and the `SANDBOX_URL` line: the app then refuses script
jobs, and HTTP jobs keep working.

## Checking a deployment

`pnpm test:docker` builds `docker-compose.yml` as a throwaway Compose project on a free port, signs up, runs a
JavaScript, a Python and a Go job, checks from inside a script that it has no network, no writable root, no Docker
socket and no deployment secrets, checks timeouts and failures, that a second sign-up is refused, and that the guard
refuses calls the sandbox does not need, and removes everything it created. Run it after changing
the Dockerfiles, the compose file, the sandbox or `apps/api/src/server.ts`; CI runs it on every pull request.
`SMOKE_KEEP=1 pnpm test:docker` leaves the stack running.

## Settings

Set these in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | (required) | Password of the bundled database. |
| `BETTER_AUTH_SECRET` | (required) | Signs sessions; at least 16 random characters. |
| `SANDBOX_TOKEN` | (required) | Shared secret between the app and the sandbox; at least 16 random characters. |
| `APP_URL` | `http://localhost:8080` | The address users open. |
| `OPENCRON_PORT` | `8080` | Host port for the app. |
| `ALLOW_PRIVATE_TARGETS` | `false` | `true` lets HTTP jobs and alert webhooks call private addresses, including other containers. |
| `SIGNUP` | `closed` | `closed` lets only the first account sign up; `open` lets anyone who can reach the app. |
| `SANDBOX_CONCURRENCY` | `4` | Scripts that run at the same time. |
| `SANDBOX_OWNER_CONCURRENCY` | half of `SANDBOX_CONCURRENCY` | How many of those one account may use at once. |
| `SANDBOX_DOCKER_RUNTIME` | (empty) | Docker runtime for script containers, for example `runsc`. |
| `SANDBOX_NETWORK` | `none` | Docker network for script containers. Anything but `none` lets scripts reach that network; never give them one that reaches Postgres or the app. |
| `SANDBOX_IMAGE_NODE`, `SANDBOX_IMAGE_PYTHON`, `SANDBOX_IMAGE_GO` | pinned digests | Images per runtime, pulled when the sandbox starts; the guard allows only these. Pin them by digest. |

The app refuses to start with the `change-me` placeholders.
