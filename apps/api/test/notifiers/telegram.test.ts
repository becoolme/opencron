import { describe, expect, it } from "vitest";
import { telegramAdapter } from "../../src/notifiers/telegram";
import type { NotifyEvent } from "../../src/notifiers/types";

const event: NotifyEvent = {
  job_id: 1, job_name: "j", error: "boom", status_code: null, started_at: 1776498572, duration_ms: 10,
};

describe("telegramAdapter", () => {
  it("POSTs { chat_id, text } to the bot's sendMessage endpoint", () => {
    const req = telegramAdapter(event, { type: "telegram", bot_token: "123:ABC", chat_id: "-100555" });
    expect(req.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(req.init.method).toBe("POST");
    const headers = req.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(req.init.body as string);
    expect(body.chat_id).toBe("-100555");
    expect(body.text).toContain(`job "j" FAILED`);
  });
});
