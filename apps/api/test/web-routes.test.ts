import { describe, expect, it } from "vitest";
import { APP_DEEP_LINK_PATTERNS, appShellPath, pageFile } from "../src/web-routes";

describe("web build pages", () => {
  it.each([
    ["/", "index.html"],
    ["/zh-Hans", "zh-Hans.html"],
    ["/ja/", "ja.html"],
    ["/app", "app.html"],
    ["/ko/app", "ko/app.html"],
    ["/app/jobs/4/edit", "app.html"],
    ["/zh-Hans/app/runs", "zh-Hans/app.html"],
    ["/missing", "missing.html"],
  ])("serves %s from %s", (path, file) => {
    expect(pageFile(path)).toBe(file);
  });

  it("refuses paths that cannot be a page", () => {
    expect(pageFile("/../secret")).toBeNull();
    expect(pageFile("/a.b")).toBeNull();
  });

  it("answers app deep links with the app page", () => {
    expect(appShellPath("/app/jobs/new")).toBe("/app");
    expect(appShellPath("/ja/app/keys")).toBe("/ja/app");
    expect(appShellPath("/app")).toBeNull();
    expect(appShellPath("/apples/1")).toBeNull();
    expect(appShellPath("/fr/app/jobs")).toBeNull();
  });

  it("sends every deep link to the Worker first", () => {
    expect(APP_DEEP_LINK_PATTERNS).toEqual(["/app/*", "/zh-Hans/app/*", "/ja/app/*", "/ko/app/*"]);
  });
});
