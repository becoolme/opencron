/// <reference types="@cloudflare/vitest-pool-workers" />

import type { WorkerLoader } from "../src/loader-types";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    SCRIPT_KV: KVNamespace;
    BETTER_AUTH_SECRET: string;
    LOADER: WorkerLoader;
    TEST_MIGRATIONS: D1Migration[];
  }
}
