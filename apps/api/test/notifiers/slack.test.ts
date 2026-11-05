import { describe, expect, it } from "vitest";
import { slackAdapter } from "../../src/notifiers/slack";
import type { NotifyEvent } from "../../src/notifiers/types";

const event: NotifyEvent = {
  job_id: 1, job_name: "j", error: "boom", status_code: 500, started_at: 1776498572, duration_ms: 10,
};

describe("slackAdapter", () => {
  it("POSTs { text } as JSON to the configured URL", () => {
    const req = slackAdapter(event, { type: "slack", url: "https://hooks.slack.com/services/AAA/BBB" });
    expect(req.url).toBe("https://hooks.slack.com/services/AAA/BBB");
    expect(req.init.method).toBe("POST");
    const headers = req.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(req.init.body as string);
    expect(body.text).toContain(`job "j" FAILED`);
    expect(body.text).toContain("error: boom");
  });
});
