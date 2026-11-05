import { describe, expect, it } from "vitest";
import { larkAdapter } from "../../src/notifiers/lark";
import type { NotifyEvent } from "../../src/notifiers/types";

const event: NotifyEvent = {
  job_id: 1, job_name: "j", error: "boom", status_code: 500, started_at: 1776498572, duration_ms: 10,
};

describe("larkAdapter", () => {
  it("POSTs msg_type=text with no signature when sign_secret absent", async () => {
    const req = await larkAdapter(event, { type: "lark", url: "https://open.feishu.cn/open-apis/bot/v2/hook/XXX" });
    expect(req.url).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/XXX");
    expect(req.init.method).toBe("POST");
    const body = JSON.parse(req.init.body as string);
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toContain(`job "j" FAILED`);
    expect(body.sign).toBeUndefined();
    expect(body.timestamp).toBeUndefined();
  });

  it("adds timestamp + sign when sign_secret is set", async () => {
    const req = await larkAdapter(event, {
      type: "lark",
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/XXX",
      sign_secret: "mysecret",
    });
    const body = JSON.parse(req.init.body as string);
    expect(typeof body.timestamp).toBe("string");
    expect(body.timestamp).toMatch(/^\d+$/);
    expect(typeof body.sign).toBe("string");
    expect(body.sign.length).toBeGreaterThan(0);
    expect(body.msg_type).toBe("text");
  });
});
