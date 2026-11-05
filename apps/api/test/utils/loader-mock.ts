import type { WorkerLoader, WorkerLoaderHandle, WorkerCode } from "../../src/loader-types";

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Build an in-process fake of Cloudflare's WorkerLoader.
 *
 * `routes` maps a cache-key (e.g. `job-1-v2`) to a fetch handler.
 * Unknown keys reply 500 to surface mistakes in tests.
 * The real loader's compilation is not simulated — the `factory` callback is
 * invoked lazily (at most once per key) but its return value is ignored.
 */
export function makeLoaderMock(routes: Record<string, Handler>): WorkerLoader {
  const seen = new Set<string>();

  function handleFor(id: string): Handler {
    const h = routes[id];
    if (h) return h;
    return () => new Response("no route for " + id, { status: 500 });
  }

  function makeHandle(id: string): WorkerLoaderHandle {
    return {
      getEntrypoint() {
        const handler = handleFor(id);
        return {
          fetch: ((req: Request, init?: { signal?: AbortSignal }) => {
            const signal = (init as { signal?: AbortSignal } | undefined)?.signal ?? req.signal;
            const handlerPromise = Promise.resolve().then(() => handler(req));
            if (!signal) return handlerPromise;
            return Promise.race([
              handlerPromise,
              new Promise<Response>((_, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            ]);
          }) as unknown as Fetcher["fetch"],
        } as unknown as Fetcher;
      },
    };
  }

  return {
    get(id, factory) {
      if (!seen.has(id)) {
        seen.add(id);
        // Run factory once per key to match the real loader's lazy-compile shape.
        // We intentionally discard the WorkerCode result; tests control behaviour via `routes`.
        try { void factory(); } catch { /* factory errors surface via handler instead */ }
      }
      return makeHandle(id);
    },
    load(_code: WorkerCode) {
      // Not used by the production code; implement for completeness.
      return {
        getEntrypoint() {
          return { fetch: async () => new Response("load() not mocked", { status: 500 }) } as unknown as Fetcher;
        },
      };
    },
  };
}
