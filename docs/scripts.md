# Script jobs

A script job is code that OpenCron runs on its schedule. Which languages you can use depends on where OpenCron runs.

## Runtimes

| Deployment | Languages | How |
| --- | --- | --- |
| Cloudflare (default) | JavaScript | A [Dynamic Worker](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/): a fresh, isolated Worker created from your code |
| Docker ([docker.md](docker.md)) | JavaScript (Node.js), Python, Go | A fresh, locked-down container per run |

On Cloudflare, scripts run on the Workers runtime with the `nodejs_compat` flag, so they are **JavaScript (ES modules)**
with the Web APIs and the Node.js APIs that Workers support. There is no Python, shell or other interpreter, and no file
system or child processes. Write plain JavaScript; TypeScript must be compiled before you paste it in.

The rest of this page describes Cloudflare. [docker.md](docker.md) covers the Docker runtimes and how they are isolated.

## Shape of a script

The module's default export handles one `fetch` per run:

```js
export default {
  async fetch(request, env) {
    const { jobId, jobName, scheduledAt } = await request.json();
    const count = Number((await env.KV.get("count")) ?? 0) + 1;
    await env.KV.put("count", String(count));
    return new Response(`run ${count} of ${jobName}`);
  },
};
```

A 2xx response marks the run as successful; anything else, a thrown error or a timeout marks it failed and triggers the
job's alerts. The first 500 characters of the response body are kept with the run.

## What a script can reach

- `env.KV`: a KV namespace scoped to this job.
- `env.D1`, `env.DB`: a SQL facade scoped to this job.
- `env.db`: the job's tables (see [database.md](database.md)).

- `env.NAME`: each secret saved on the Secrets page (see below).

Nothing else. Scripts have **no outbound network access** (`globalOutbound` is `null`) and never see the deployment's
own settings. To call an API on a schedule, use an HTTP job.

## Secrets

Tokens, passwords and other values a script needs belong on the **Secrets** page, not in its source. Each secret of
your account reaches every script job of your account:

| Runtime | Read it with |
| --- | --- |
| JavaScript (Cloudflare and Docker) | `env.API_TOKEN`, the second argument of `fetch(request, env)` |
| Python | `os.environ["API_TOKEN"]` |
| Go | `os.Getenv("API_TOKEN")` |

- Names use capital letters, digits and underscores and do not start with a digit (`API_TOKEN`, `SMTP_PASSWORD`).
  Names the runtimes rely on are refused: `PATH`, `HOME`, `TZ`, `LANG` and the like, `NODE_*`, `PYTHON*` and `GO*`
  settings, `DB`, `D1`, `KV`, anything ending in `_PROXY`, and anything starting with `OPENCRON_`, `DOCKER_`,
  `SANDBOX_`, `LD_` or `SSL_`.
- An account holds up to 50 secrets, each up to 16 KB and 64 KB in all.
- Values are encrypted in the database with a key derived from `BETTER_AUTH_SECRET` and are never shown again after
  saving. To change one, save a new value.
- A run's error and response snippet have every secret value of 4 characters or more replaced with `***`. This guards
  against printing a secret by accident, not against a script that encodes it on purpose.
- A change takes effect from the next run.

If `BETTER_AUTH_SECRET` changes, saved values can no longer be decrypted: runs fail with a message naming the secret
until it is saved again.
