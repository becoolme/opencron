import { defineConfig } from "vitest/config";

// Unit tests cover the plain TypeScript modules; they skip the Cloudflare plugin that vite.config.ts loads.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: { TZ: "UTC" },
  },
});
