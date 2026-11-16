import type { APIRoute } from "astro";
import { HTML_LANG, SITE_LOCALES, landingPath } from "../site";

/** Every language of the landing page, each listing the others as alternates. */
export const GET: APIRoute = ({ site }) => {
  const url = (path: string) => new URL(path, site).href;
  const alternates = [
    ...SITE_LOCALES.map((locale) => `    <xhtml:link rel="alternate" hreflang="${HTML_LANG[locale]}" href="${url(landingPath(locale))}"/>`),
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${url(landingPath("en"))}"/>`,
  ].join("\n");
  const entries = SITE_LOCALES.map((locale) => `  <url>\n    <loc>${url(landingPath(locale))}</loc>\n${alternates}\n  </url>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join("\n")}
</urlset>
`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
