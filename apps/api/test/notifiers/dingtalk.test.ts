import { describe, expect, it } from "vitest";
import { dingtalkAdapter } from "../../src/notifiers/dingtalk";
import type { NotifyEvent } from "../../src/notifiers/types";

const event: NotifyEvent = {
  job_id: 1, job_name: "j", error: "boom", status_code: 500, started_at: 1776498572, duration_ms: 10,
};

describe("dingtalkAdapter", () => {
  it("POSTs msgtype=text to bare URL when no secret", async () => {
    const req = await dingtalkAdapter(event, {
      type: "dingtalk",
      url: "https://oapi.dingtalk.com/robot/send?access_token=TOKEN",
    });
    expect(req.url).toBe("https://oapi.dingtalk.com/robot/send?access_token=TOKEN");
    const body = JSON.parse(req.init.body as string);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain(`job "j" FAILED`);
  });

  it("appends timestamp + sign as query params when sign_secret set", async () => {
    const req = await dingtalkAdapter(event, {
      type: "dingtalk",
      url: "https://oapi.dingtalk.com/robot/send?access_token=TOKEN",
      sign_secret: "mysecret",
    });
    const u = new URL(req.url);
    expect(u.searchParams.get("access_token")).toBe("TOKEN");
    expect(u.searchParams.get("timestamp")).toMatch(/^\d+$/);
    expect(u.searchParams.get("sign")).not.toBeNull();
    expect(u.searchParams.get("sign")!.length).toBeGreaterThan(0);
  });
});
