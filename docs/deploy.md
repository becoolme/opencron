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
   pnpm db:migrate:remote:0002   # …through 0007
   pnpm --filter @opencron/api exec wrangler secret put BETTER_AUTH_SECRET
   ```

4. Build and deploy:

   ```bash
   pnpm deploy
   ```

To use Postgres instead of D1, follow [database.md](database.md) and use `pnpm deploy:postgres`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_URL` | `http://localhost:5173` | Public URL of the deployment. Sign-in is accepted from its host and from localhost. |
| `ALLOW_PRIVATE_TARGETS` | `false` | `true` lets HTTP jobs and alert webhooks call private or internal addresses. |
| `SIGNUP` | `open` | `closed` lets only the first account sign up; later sign-ups are refused. The Docker setup defaults to `closed`. |
| `DB_PROVIDER` | `d1` | `postgres` reads `DATABASE_URL` or a Hyperdrive binding instead. |
| `BETTER_AUTH_SECRET` | (secret) | At least 32 random characters. |
