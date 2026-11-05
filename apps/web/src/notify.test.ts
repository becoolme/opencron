import { describe, expect, it } from "vitest";
import { draftToTarget, emptyNotifyDraft, maskSecret, targetSummary } from "./notify";
import type { NotifyDraft } from "./types";

function draft(patch: Partial<NotifyDraft>): NotifyDraft {
  return { ...emptyNotifyDraft(patch.type), ...patch };
}

describe("draftToTarget", () => {
  it("needs both telegram fields", () => {
    expect(draftToTarget(draft({ type: "telegram", bot_token: "123:abc" })).error).toBeTruthy();
    expect(draftToTarget(draft({ type: "telegram", bot_token: " 123:abc ", chat_id: " -100 " })).target).toEqual({
      type: "telegram",
      bot_token: "123:abc",
      chat_id: "-100",
    });
  });

  it("requires https for chat webhooks", () => {
    for (const type of ["slack", "discord", "lark", "dingtalk"] as const) {
      expect(draftToTarget(draft({ type, url: "http://hooks.example.com/x" })).error).toBeTruthy();
      expect(draftToTarget(draft({ type, url: "https://hooks.example.com/x" })).target).toMatchObject({ type, url: "https://hooks.example.com/x" });
    }
  });

  it("allows http for the generic webhook", () => {
    expect(draftToTarget(draft({ type: "http", url: "http://10.0.0.2/hook" })).target).toEqual({ type: "http", url: "http://10.0.0.2/hook" });
    expect(draftToTarget(draft({ type: "http", url: "ftp://x" })).error).toBeTruthy();
    expect(draftToTarget(draft({ type: "http", url: "" })).error).toBeTruthy();
  });

  it("checks generic webhook headers", () => {
    const base = { type: "http" as const, url: "https://example.com/hook" };
    expect(draftToTarget(draft({ ...base, headers_text: "{" })).error).toBeTruthy();
    expect(draftToTarget(draft({ ...base, headers_text: "[]" })).error).toBeTruthy();
    expect(draftToTarget(draft({ ...base, headers_text: '{"x": 1}' })).error).toBeTruthy();
    expect(draftToTarget(draft({ ...base, headers_text: '{"x-key": "v"}' })).target).toEqual({ ...base, headers: { "x-key": "v" } });
  });

  it("keeps a signing secret only when one is given", () => {
    const url = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";
    expect(draftToTarget(draft({ type: "lark", url, sign_secret: "  " })).target).toEqual({ type: "lark", url });
    expect(draftToTarget(draft({ type: "lark", url, sign_secret: "s3" })).target).toEqual({ type: "lark", url, sign_secret: "s3" });
  });
});

describe("summaries", () => {
  it("masks secrets", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("short")).toBe("•••");
    expect(maskSecret("1234567890abcdef")).toBe("1234…cdef");
  });

  it("never shows a webhook path, which often holds the token", () => {
    expect(targetSummary({ type: "slack", url: "https://hooks.slack.com/services/T0/B0/secret" })).toBe("hooks.slack.com/…");
    expect(targetSummary({ type: "telegram", bot_token: "1234567890:ABCDEFGH", chat_id: "-100" })).toBe("1234…EFGH → -100");
  });
});
