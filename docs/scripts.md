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

Nothing else. Scripts have **no outbound network access** (`globalOutbound` is `null`) and never see the deployment's
secrets. To call an API on a schedule, use an HTTP job.
