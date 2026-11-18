import { describe, expect, it } from "vitest";
import { localePath, splitPath } from "./i18n";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { zh } from "./locales/zh";
import { inApp, parse } from "./routes";

describe("language paths", () => {
  it.each([
    ["/", "en", "/"],
    ["/jobs/4", "en", "/jobs/4"],
    ["/zh-Hans", "zh-CN", "/"],
    ["/zh-Hans/jobs/4/edit", "zh-CN", "/jobs/4/edit"],
    ["/ja/runs", "ja", "/runs"],
    ["/ko/", "ko", "/"],
    ["/japan", "en", "/japan"],
  ] as const)("splits %s", (path, locale, rest) => {
    expect(splitPath(path)).toEqual({ locale, rest });
  });

  it("builds prefixed addresses", () => {
    expect(localePath("en", "/")).toBe("/");
    expect(localePath("en", "/runs")).toBe("/runs");
    expect(localePath("zh-CN", "/")).toBe("/zh-Hans");
    expect(localePath("ja", "/jobs/4")).toBe("/ja/jobs/4");
    expect(localePath("ko", "/runs")).toBe("/ko/runs");
  });

  it("routes the path after the prefix", () => {
    expect(parse(splitPath("/ko/app/jobs/7/edit").rest)).toEqual({ name: "edit", id: 7 });
    expect(parse(splitPath("/zh-Hans/app").rest)).toEqual({ name: "jobs" });
    expect(parse("/app/runs")).toEqual({ name: "runs" });
    expect(parse("/jobs/new")).toEqual({ name: "new" });
    expect(parse("/runs/")).toEqual({ name: "runs" });
    expect(parse("/secrets")).toEqual({ name: "secrets" });
    expect(parse("/keys")).toEqual({ name: "keys" });
    expect(parse("/app/members")).toEqual({ name: "members" });
    expect(parse("/app/settings")).toEqual({ name: "settings" });
    expect(parse(splitPath("/ja/app/invite/3f2a-b1").rest)).toEqual({ name: "invite", id: "3f2a-b1" });
    expect(parse("/app/invite/a/b")).toEqual({ name: "missing" });
    expect(parse("/nowhere")).toEqual({ name: "missing" });
    expect(parse("/app/jobs/7/nowhere")).toEqual({ name: "missing" });
  });

  it("knows which paths belong to the app", () => {
    expect(inApp("/app")).toBe(true);
    expect(inApp("/app/jobs/4")).toBe(true);
    expect(inApp("/")).toBe(false);
    expect(inApp("/apples")).toBe(false);
  });
});

// Every literal t("…") key in the app, so each dictionary can be checked against the source.
const sources = import.meta.glob<string>(["./**/*.{vue,ts}", "!./**/*.test.ts", "!./locales/**", "!./i18n.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function sourceKeys(): Set<string> {
  const keys = new Set<string>();
  const nonLiteral: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/\bt\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g)) {
      keys.add(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2].replace(/\\'/g, "'"));
    }
    // preset.label reads the `label:` literals collected below.
    for (const m of text.matchAll(/\bt\(\s*(?!preset\.label\))[`\w]/g)) nonLiteral.push(`${file}: ${text.slice(m.index, m.index + 40)}`);
    for (const m of text.matchAll(/\blabel:\s*"([^"]+)"/g)) keys.add(m[1]);
  }
  expect(Object.keys(sources).length).toBeGreaterThan(5);
  expect(nonLiteral, "t() keys must be string literals").toEqual([]);
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe.each([
  ["zh", zh],
  ["ja", ja],
  ["ko", ko],
] as const)("%s dictionary", (_name, dict) => {
  it("covers every string in the app and nothing else", () => {
    const keys = sourceKeys();
    expect([...keys].filter((k) => !(k in dict)), "missing").toEqual([]);
    expect(Object.keys(dict).filter((k) => !keys.has(k)), "unused").toEqual([]);
  });

  it("keeps placeholders and has no empty text", () => {
    for (const [key, value] of Object.entries(dict)) {
      expect(key.trim(), key).not.toBe("");
      expect(value.trim(), key).not.toBe("");
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
