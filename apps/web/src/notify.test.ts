import { describe, expect, it } from "vitest";
import { channelSummary, configToDraft, draftToConfig, draftToTarget, emptyNotifyDraft } from "./notify";
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

describe("saved channels", () => {
  it("fills a draft from a masked config and sends it back unchanged", () => {
    const masked = { url: "https://open.feishu.cn/…1234", sign_secret: "***" };
    const draft = configToDraft("lark", masked);
    expect(draft).toMatchObject({ type: "lark", url: masked.url, sign_secret: "***" });
    expect(draftToConfig(draft, true).config).toEqual(masked);
  });

  it("removes the signing secret when it is cleared while editing", () => {
    const draft = configToDraft("dingtalk", { url: "https://oapi.dingtalk.com/…abcd", sign_secret: "***" });
    draft.sign_secret = "";
    expect(draftToConfig(draft, true).config).toEqual({ url: "https://oapi.dingtalk.com/…abcd", sign_secret: null });
    expect(draftToConfig(draft, false).config).toEqual({ url: "https://oapi.dingtalk.com/…abcd" });
  });

  it("keeps masked header values as JSON", () => {
    const draft = configToDraft("http", { url: "https://example.com/…hook", headers: { Authorization: "***" } });
    expect(draftToConfig(draft, true).config).toEqual({ url: "https://example.com/…hook", headers: { Authorization: "***" } });
  });

  it("summarises a channel without its secrets", () => {
    expect(channelSummary("slack", { url: "https://hooks.slack.com/…1234" })).toBe("hooks.slack.com");
    expect(channelSummary("telegram", { bot_token: "…WXYZ", chat_id: "-100" })).toBe("…WXYZ → -100");
    expect(channelSummary("slack", null)).toBeTruthy();
  });
});
