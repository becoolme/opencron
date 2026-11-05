import { describe, expect, it } from "vitest";
import { httpAdapter } from "../../src/notifiers/http";
import type { NotifyEvent } from "../../src/notifiers/types";

const event: NotifyEvent = {
  job_id: 42, job_name: "hello", error: "boom", status_code: 500, started_at: 1776498572, duration_ms: 999,
};

describe("httpAdapter", () => {
  it("POSTs NotifyEvent + ISO time as JSON", () => {
    const req = httpAdapter(event, { type: "http", url: "https://my.example/hook" });
    expect(req.url).toBe("https://my.example/hook");
    expect(req.init.method).toBe("POST");
    const body = JSON.parse(req.init.body as string);
    expect(body).toEqual({
      job_id: 42, job_name: "hello",
      error: "boom", status_code: 500,
      started_at: 1776498572, duration_ms: 999,
      time: "2026-04-18T07:49:32Z",
    });
    const headers = req.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("merges user-supplied headers (but content-type wins)", () => {
    const req = httpAdapter(event, {
      type: "http",
      url: "https://my.example/hook",
      headers: { "x-api-key": "sekret", "content-type": "text/plain" },
    });
    const headers = req.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sekret");
    expect(headers["content-type"]).toBe("application/json");
  });
});
