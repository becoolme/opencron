import { describe, expect, it } from "vitest";
import { getAdapter } from "../../src/notifiers";

describe("getAdapter", () => {
  it("returns distinct adapters for each supported type", () => {
    const types = ["http", "lark", "telegram", "dingtalk", "slack", "discord"] as const;
    const fns = types.map(getAdapter);
    const uniq = new Set(fns);
    expect(uniq.size).toBe(types.length);
  });

  it("throws on unknown type", () => {
    expect(() => getAdapter("pager" as any)).toThrow(/unknown notify type/i);
  });
});
