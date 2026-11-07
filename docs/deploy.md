# Deploy to Cloudflare

To run OpenCron on your own server instead, see [docker.md](docker.md).

OpenCron deploys as one Worker with static assets, a cron trigger, a D1 database, a KV namespace and a Worker Loader
binding (for script jobs). The commands run from the repository root.

1. Create the database and the namespace, and paste their ids into `apps/api/wrangler.toml`:

   ```bash
   pnpm --filter @opencron/api exec wrangler d1 create opencron
   pnpm --filter @opencron/api exec wrangler kv namespace create SCRIPT_KV
   ```

2. Set `APP_URL` in `apps/api/wrangler.toml` to the URL you will serve on, and uncomment `[[routes]]` with your domain
   (or leave it commented to use the `workers.dev` address).

3. Apply the migrations and set the auth secret:

   ```bash
   pnpm db:init:remote
   pnpm db:migrate:remote:0002   # …through 0009
   pnpm --filter @opencron/api exec wrangler secret put BETTER_AUTH_SECRET
   ```

4. Build and deploy:

   ```bash
   pnpm deploy
   ```

To use Postgres instead of D1, follow [database.md](database.md) and use `pnpm deploy:postgres`.

## Python and Go on Cloudflare

On Cloudflare, script jobs are JavaScript, run by the Worker Loader. To offer Python and Go as well, run the script
sandbox from the Docker setup on a server of your own and point the Worker at it. JavaScript jobs keep running in the
Worker; Python and Go jobs are sent to the sandbox, which runs each in a fresh container with the limits described in
[docker.md](docker.md#how-scripts-are-isolated). Without `SANDBOX_URL` nothing changes: the app offers JavaScript only.

You need a Linux server with Docker and a domain on Cloudflare. The sandbox publishes no port: a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) connects out from the
server and gives it an HTTPS hostname.

1. In the Cloudflare dashboard, under **Zero Trust → Networks → Tunnels**, create a tunnel, copy its token, and add a
   public hostname (for example `sandbox.example.com`) for the service `http://sandbox:8787`.

2. On the server, clone this repository and start the sandbox:

   ```bash
   cp .env.sandbox.example .env.sandbox   # set SANDBOX_TOKEN (openssl rand -hex 32) and TUNNEL_TOKEN
   docker compose -f docker-compose.sandbox.yml --env-file .env.sandbox up -d --build
   ```

   It runs the `sandbox`, the `docker-guard` that holds the Docker socket, and `cloudflared`. The sandbox pulls its
   three runtime images on first start.

3. Point the Worker at it. Set `SANDBOX_URL = "https://sandbox.example.com"` under `[vars]` in
   `apps/api/wrangler.toml`, then set the same token as a secret and deploy:

   ```bash
   pnpm --filter @opencron/api exec wrangler secret put SANDBOX_TOKEN
   pnpm deploy
   ```

The job editor now offers Python and Go, and `GET /api/meta` lists all three runtimes.

Every Python or Go run carries the script and the account's secrets to the sandbox, so `SANDBOX_URL` must be HTTPS
(plain HTTP is accepted only for localhost, a Compose service name or a private IPv4 address), and `SANDBOX_TOKEN` must
be at least 16 random characters. Anyone who has the token and can reach the hostname can run code on your server. To
add a second lock, protect the hostname with a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
application whose only policy allows a service token, and give the Worker that token:

```bash
pnpm --filter @opencron/api exec wrangler secret put SANDBOX_ACCESS_CLIENT_ID
pnpm --filter @opencron/api exec wrangler secret put SANDBOX_ACCESS_CLIENT_SECRET
```

The Worker then sends them as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and Access refuses every other
request before it reaches the server.

Things to know:

- Each run adds a round trip to the server and a container start; Go also compiles before it runs.
- The sandbox runs `SANDBOX_CONCURRENCY` scripts at a time (4 by default) and queues the rest. Size the server for the
  Python and Go jobs that fall due in the same minute.
- The table store, D1 facade and KV namespace of [scripts.md](scripts.md) stay JavaScript only; Python and Go scripts
  get the account's secrets and the run context, as on Docker.
- If the sandbox is down, Python and Go runs fail with the error in the run history and alert as usual; JavaScript and
  HTTP jobs are not affected.
- Accounts on your deployment can run code on that server. Keep `SIGNUP = "closed"` unless you trust everyone who can
  sign up, and read [Untrusted users](docker.md#untrusted-users) before you open it.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_URL` | `http://localhost:5173` | Public URL of the deployment. Sign-in is accepted from its host and from localhost. |
| `ALLOW_PRIVATE_TARGETS` | `false` | `true` lets HTTP jobs and alert webhooks call private or internal addresses. |
| `SIGNUP` | `open` | `closed` lets only the first account sign up; later sign-ups are refused. The Docker setup defaults to `closed`. |
| `SANDBOX_URL` | (none) | Optional. HTTPS address of a script sandbox for Python and Go jobs; see [above](#python-and-go-on-cloudflare). |
| `SANDBOX_TOKEN` | (secret) | Required with `SANDBOX_URL`: the shared token the sandbox checks, at least 16 random characters. |
| `SANDBOX_ACCESS_CLIENT_ID`, `SANDBOX_ACCESS_CLIENT_SECRET` | (secrets) | Optional. A Cloudflare Access service token, sent to a sandbox behind Access. Set both or neither. |
| `DB_PROVIDER` | `d1` | `postgres` reads `DATABASE_URL` or a Hyperdrive binding instead. |
| `BETTER_AUTH_SECRET` | (secret) | At least 32 random characters. It also encrypts the values on the Secrets page: changing it signs everyone out and leaves those values unreadable until they are saved again. |
