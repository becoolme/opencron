import { afterEach, describe, expect, it } from "vitest";
import { BlockedTarget, guardedFetch } from "@openuptime/kit/netguard";
import { applyOutboundPolicy } from "../src/outbound";

describe("outbound policy", () => {
  afterEach(() => applyOutboundPolicy({}));

  it("refuses private and internal targets by default", async () => {
    applyOutboundPolicy({});
    for (const url of ["http://127.0.0.1/", "http://localhost:8080/", "http://169.254.169.254/latest/meta-data", "http://db/"]) {
      await expect(guardedFetch(url)).rejects.toBeInstanceOf(BlockedTarget);
    }
  });

  it("lets them through when ALLOW_PRIVATE_TARGETS is true", async () => {
    applyOutboundPolicy({ ALLOW_PRIVATE_TARGETS: "true" });
    // no longer refused by the guard: whatever happens next is the network's answer, not BlockedTarget
    await expect(guardedFetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(500) })).rejects.not.toBeInstanceOf(BlockedTarget);
  });
});
