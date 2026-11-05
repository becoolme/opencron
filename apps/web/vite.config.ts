import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import * as vueCompiler from "vue/compiler-sfc";

// The web app and the API ship as one Worker: the Cloudflare plugin builds the Worker from
// apps/api and serves this app as its static assets. OPENCRON_CONFIG picks another wrangler
// config, relative to this folder (for example ../api/wrangler.postgres.toml).
export default defineConfig({
  // Cloudflare's plugin generates Worker metadata during startup. Supplying
  // compiler-sfc eagerly prevents Vue's HMR type-cache invalidation from
  // racing the plugin's lazy compiler initialization.
  plugins: [vue({ compiler: vueCompiler }), tailwindcss(), cloudflare({ configPath: process.env.OPENCRON_CONFIG ?? "../api/wrangler.toml" })],
});
