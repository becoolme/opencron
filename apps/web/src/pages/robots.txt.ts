import type { APIRoute } from "astro";
import { SITE_LOCALES, appPath } from "../site";

/** The landing pages are for search engines; the app and the API are not. */
export const GET: APIRoute = ({ site }) => {
  const lines = [
    "User-agent: *",
    ...SITE_LOCALES.map((locale) => `Disallow: ${appPath(locale)}`),
    "Disallow: /api/",
    "",
    `Sitemap: ${new URL("/sitemap.xml", site)}`,
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
};
