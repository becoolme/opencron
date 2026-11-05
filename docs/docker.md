# Self-host with Docker

`docker-compose.yml` runs OpenCron on your own machine or server as three containers:

| Service | What it does | Networks |
| --- | --- | --- |
| `app` | The web app, the API and the every-minute scheduler, in one Node process | default (published port) and internal |
| `postgres` | The database | internal only |
| `sandbox` | Runs script jobs in Node.js, Python or Go, one fresh container per run | internal only |

## Start it

```bash
cp .env.docker.example .env      # replace every change-me value: openssl rand -hex 32
docker compose up -d --build
```

Open `http://localhost:8080` (or `APP_URL`) and create an account. The app applies the database migrations when it
starts. The sandbox pulls its three runtime images on first start, which takes a minute or two.

Run **one** `app` container: it runs the scheduler, and two of them would run every job twice.

Upgrade with `git pull && docker compose up -d --build`. Back up the `postgres-data` volume (or `pg_dump`) like any
other Postgres database.

## Script runtimes

On Docker, script jobs can be written in:

| Runtime | Image (default) | How it runs |
| --- | --- | --- |
| JavaScript | `node:22-alpine` | An ES module. `export default { fetch(request, env, ctx) }` as on Cloudflare, or a default function that receives the run context. |
| Python | `python:3.12-alpine` | `python3 main.py`. Standard library only. |
| Go | `golang:1.23-alpine` | `go run main.go` in `package main`. Standard library only; the first run of a job includes compile time. |

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
- 512 MB of memory without swap (1 GB for Go), one CPU, 64 processes, 256 open files;
- no volumes, no Docker socket, no environment from the host; the image is never pulled at run time;
- killed once the job's timeout passes (Go gets 30 seconds on top for compiling, the others 2 seconds); the container is
  removed afterwards.

The app calls the sandbox with a shared `SANDBOX_TOKEN`. The sandbox refuses sources over 512 KB, keeps at most 64 KB of
each output stream, and runs `SANDBOX_CONCURRENCY` scripts at a time (4 by default); further runs queue.

### The Docker socket

To start containers, the `sandbox` service mounts `/var/run/docker.sock`. **Access to that socket is root on the
host.** That is why only the sandbox has it, why it sits on an internal network with no published port, and why it only
accepts requests carrying the token. Scripts never see it.

For stronger isolation:

- install [gVisor](https://gvisor.dev/docs/user_guide/install/) and set `SANDBOX_DOCKER_RUNTIME=runsc`, so scripts run
  against a user-space kernel instead of the host's;
- or run Docker in [rootless mode](https://docs.docker.com/engine/security/rootless/), so the socket is not root;
- and do not run other important workloads on the same Docker host if your users are not trusted.

If you do not need Python or Go, remove the `sandbox` service and the `SANDBOX_URL` line: the app then refuses script
jobs, and HTTP jobs keep working.

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
| `SANDBOX_CONCURRENCY` | `4` | Scripts that run at the same time. |
| `SANDBOX_DOCKER_RUNTIME` | (empty) | Docker runtime for script containers, for example `runsc`. |
| `SANDBOX_NETWORK` | `none` | Docker network for script containers. Anything but `none` lets scripts reach that network; never give them one that reaches Postgres or the app. |
| `SANDBOX_IMAGE_NODE`, `SANDBOX_IMAGE_PYTHON`, `SANDBOX_IMAGE_GO` | see above | Images per runtime, pulled when the sandbox starts. |

The app refuses to start with the `change-me` placeholders.
