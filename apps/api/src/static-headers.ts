/**
 * The web build's `_headers` file, applied by the self-hosted server the way Cloudflare applies it: a path pattern on
 * its own line, then indented `Name: value` lines. A pattern ending in `*` matches by prefix; every matching rule adds
 * its headers, later rules winning.
 */
export type HeaderRules = Array<[pattern: string, headers: Array<[string, string]>]>;

export function parseHeaders(text: string): HeaderRules {
  const rules: HeaderRules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { rules.push([line.trim(), []]); continue; }
    const colon = line.indexOf(":");
    if (colon > 0 && rules.length) rules[rules.length - 1][1].push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

export function matchesPattern(pattern: string, path: string): boolean {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

/** The headers for a response to `path`; API responses get none, since the API sets its own. */
export function headersFor(rules: HeaderRules, path: string): Array<[string, string]> {
  if (path.startsWith("/api/")) return [];
  return rules.filter(([pattern]) => matchesPattern(pattern, path)).flatMap(([, headers]) => headers);
}
