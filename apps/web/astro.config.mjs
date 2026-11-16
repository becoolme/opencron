import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { readFileSync } from "node:fs";
import { appShellPath } from "../api/src/web-routes.ts";

// A static site: the landing page and the app page, each with a copy per language, built into dist/ and served as
// assets by the Worker (apps/api/wrangler.toml) or by the Docker server. In development the API runs in
// `wrangler dev` on :8787 (started next to this by `pnpm dev`) and /api is proxied to it.
const api = process.env.OPENCRON_API ?? "http://127.0.0.1:8787";

/**
 * The public URL baked into canonical links, hreflang, Open Graph tags, robots.txt and the sitemap. APP_URL in the build
 * environment wins (the Docker build passes it); otherwise the Worker's APP_URL in apps/api/wrangler.toml, which a
 * Cloudflare deploy builds from.
 */
function siteUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;
  const wrangler = readFileSync(new URL("../api/wrangler.toml", import.meta.url), "utf8");
  return wrangler.match(/^APP_URL\s*=\s*"([^"]+)"/m)?.[1] ?? "http://localhost:5173";
}

/** The dev server answers app deep links with the app page, as the Worker does in production. */
function appDeepLinks() {
  return {
    name: "opencron-app-deep-links",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = (req.url ?? "/").split("?");
        const shell = appShellPath(path);
        if (shell) req.url = query ? `${shell}?${query}` : shell;
        next();
      });
    },
  };
}

export default defineConfig({
  site: siteUrl(),
  output: "static",
  // Stylesheets stay files too: the CSP has no hash for inline <style> blocks.
  build: { format: "file", inlineStylesheets: "never" },
  trailingSlash: "never",
  devToolbar: { enabled: false },
  server: { port: 5173 },
  integrations: [vue()],
  vite: {
    plugins: [tailwindcss(), appDeepLinks()],
    // The CSP allows only scripts from the site itself, so nothing may be inlined into the HTML.
    build: { assetsInlineLimit: 0 },
    server: {
      proxy: {
        "/api": { target: api, changeOrigin: false },
        "/cdn-cgi": { target: api, changeOrigin: false },
      },
    },
  },
});
