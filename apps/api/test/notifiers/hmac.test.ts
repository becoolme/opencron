import { describe, expect, it } from "vitest";
import { hmacSha256Base64 } from "../../src/notifiers/hmac";

describe("hmacSha256Base64", () => {
  it("is deterministic for identical key+data", async () => {
    const a = await hmacSha256Base64("the-key", "the-data");
    const b = await hmacSha256Base64("the-key", "the-data");
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
  });

  it("changes with different data", async () => {
    const a = await hmacSha256Base64("k", "a");
    const b = await hmacSha256Base64("k", "b");
    expect(a).not.toBe(b);
  });

  it("changes with different key", async () => {
    const a = await hmacSha256Base64("k1", "d");
    const b = await hmacSha256Base64("k2", "d");
    expect(a).not.toBe(b);
  });

  it("handles empty data (Lark case)", async () => {
    const out = await hmacSha256Base64("1700000000\ntestsecret", "");
    expect(out.length).toBeGreaterThan(0);
  });
});
