/**
 * Where the static web build's pages are, shared by the Worker, the Docker server and the web dev server.
 *
 * The build is static: the landing page at `/`, and the app at `/app`, both with a copy under each language prefix
 * (`/zh-Hans`, `/ja`, `/ko`). The app routes in the browser, so every address under `/app/` is answered with the app
 * page itself.
 */

const LOCALE_PREFIXES = ["zh-Hans", "ja", "ko"];

const APP_DEEP_LINK = new RegExp(`^(/(?:${LOCALE_PREFIXES.join("|")}))?/app/`);

/** The app page that answers a path under `/app/`: `/ja/app/jobs/4` → `/ja/app`. Null for any other path. */
export function appShellPath(pathname: string): string | null {
  const match = pathname.match(APP_DEEP_LINK);
  return match ? `${match[1] ?? ""}/app` : null;
}

/** The `run_worker_first` patterns that send app deep links to the Worker, which then serves the app page. */
export const APP_DEEP_LINK_PATTERNS = ["/app/*", ...LOCALE_PREFIXES.map((prefix) => `/${prefix}/app/*`)];

/**
 * The HTML file of the build that answers a page path, the way Cloudflare's assets serve an Astro `file` build:
 * `/` → `index.html`, `/ja/app` → `ja/app.html`, deep app links → the app page. Null when the path cannot be a page.
 */
export function pageFile(pathname: string): string | null {
  const page = (appShellPath(pathname) ?? pathname).replace(/\/+$/, "");
  if (!page) return "index.html";
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(page)) return null;
  return `${page.slice(1)}.html`;
}
