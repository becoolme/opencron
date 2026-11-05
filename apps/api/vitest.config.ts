import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// LOADER (worker_loaders) is not exposed by miniflare's JS binding API —
// miniflare rejects function-valued bindings. Tests exercising script jobs
// assign env.LOADER = makeLoaderMock(...) at runtime before invoking runScriptJob.
export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);
  return {
    test: {
      poolOptions: {
        workers: {
          main: "./src/index.ts",
          singleWorker: true,
          miniflare: {
            compatibilityDate: "2024-12-30",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters-minimum",
              APP_URL: "https://cron.example.com",
            },
            d1Databases: ["DB"],
            kvNamespaces: ["SCRIPT_KV"],
          },
        },
      },
    },
  };
});
