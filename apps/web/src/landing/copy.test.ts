import { describe, expect, it } from "vitest";
import { LANDING } from "./copy";

/** Every leaf of a copy object, as "section.key" → text. */
function leaves(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") for (const [k, v] of leaves(child, path)) out.set(k, v);
    else out.set(path, child);
  }
  return out;
}

describe("landing copy", () => {
  const en = leaves(LANDING.en);

  for (const [locale, copy] of Object.entries(LANDING)) {
    it(`${locale} has every key, each with text`, () => {
      const own = leaves(copy);
      expect([...own.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, text] of own) {
        expect(typeof text, key).toBe("string");
        expect((text as string).trim(), key).not.toBe("");
      }
    });

    it(`${locale} keeps the {n} placeholder`, () => {
      expect(copy.dash.inMin).toContain("{n}");
    });
  }
});
