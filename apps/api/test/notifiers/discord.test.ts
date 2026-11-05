import { describe, expect, it } from "vitest";
import { discordAdapter } from "../../src/notifiers/discord";
import type { NotifyEvent } from "../../src/notifiers/types";

const event: NotifyEvent = {
  job_id: 1, job_name: "j", error: "boom", status_code: 500, started_at: 1776498572, duration_ms: 10,
};

describe("discordAdapter", () => {
  it("POSTs { content } as JSON to the configured URL", () => {
    const req = discordAdapter(event, { type: "discord", url: "https://discord.com/api/webhooks/AAA/BBB" });
    expect(req.url).toBe("https://discord.com/api/webhooks/AAA/BBB");
    expect(req.init.method).toBe("POST");
    const body = JSON.parse(req.init.body as string);
    expect(body.content).toContain(`job "j" FAILED`);
    expect(body.content).toContain("error: boom");
  });
});
