// Local typings for the Cloudflare Dynamic Workers binding (open beta 2026-03-24).
// Intentionally narrower than @cloudflare/workers-types's WorkerStub / WorkerLoaderWorkerCode:
// - modules is Record<string, string> (we only load plain JS source)
// - WorkerLoader.get(id) is string-only (we always pass a cache key)
// - WorkerLoaderHandle.getEntrypoint() has no params (we always call the default entrypoint)
// Omitted: allowExperimental, limits, tails, streamingTails.
// Expand these shapes if a future task needs them.

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  env?: Record<string, unknown>;
  globalOutbound?: Fetcher | null;
}

export interface WorkerLoaderHandle {
  getEntrypoint(): Fetcher;
}

export interface WorkerLoader {
  get(
    id: string,
    factory: () => WorkerCode | Promise<WorkerCode>,
  ): WorkerLoaderHandle;
  load(code: WorkerCode): WorkerLoaderHandle;
}
