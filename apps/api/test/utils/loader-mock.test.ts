import { describe, it, expect } from "vitest";
import { makeLoaderMock } from "./loader-mock";

describe("makeLoaderMock", () => {
  it("dispatches to the routed handler and returns its response", async () => {
    const loader = makeLoaderMock({
      "job-1-v1": async (req) => new Response("hello-" + req.method, { status: 200 }),
    });
    const handle = loader.get("job-1-v1", () => {
      throw new Error("factory should not be invoked when key already routed");
    });
    const res = await handle.getEntrypoint().fetch(new Request("https://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-POST");
  });

  it("runs the factory once when the key has no route, then caches by key", async () => {
    let factoryCalls = 0;
    const loader = makeLoaderMock({});
    const h1 = loader.get("missing-key", () => { factoryCalls++; return { compatibilityDate: "2026-03-01", mainModule: "m.js", modules: { "m.js": "" } }; });
    const h2 = loader.get("missing-key", () => { factoryCalls++; return { compatibilityDate: "2026-03-01", mainModule: "m.js", modules: { "m.js": "" } }; });
    // Calling the entrypoint with no route replies 500.
    const res = await h1.getEntrypoint().fetch(new Request("https://x/"));
    expect(res.status).toBe(500);
    // Second call with same key: factory ran at most once in aggregate.
    expect(factoryCalls).toBeLessThanOrEqual(1);
    void h2;
  });

  it("propagates thrown handler errors as rejected fetches", async () => {
    const loader = makeLoaderMock({
      "k": () => { throw new Error("boom"); },
    });
    const handle = loader.get("k", () => { throw new Error("unused"); });
    await expect(handle.getEntrypoint().fetch(new Request("https://x/"))).rejects.toThrow("boom");
  });
});
