import { describe, expect, it } from "vitest";
import { authPath, authRedirect, returnDestination } from "./auth-routes";
import { parse } from "./routes";

describe("authentication routes", () => {
  it("parses login and registration independently", () => {
    expect(parse("/app/sign-in")).toEqual({ name: "sign-in" });
    expect(parse("/app/sign-up/")).toEqual({ name: "sign-up" });
  });

  it.each(["/app/jobs/42/edit?tab=script#editor", "/zh-Hans/app/runs?status=failed", "/ja/app/keys"]) (
    "returns to %s after signing in or signing up", (target) => {
      const login = authRedirect(target, false)!;
      expect(login).toContain("/app/sign-in?returnTo=");
      expect(authRedirect(login, false)).toBeNull();
      const signup = authPath(login, "sign-up");
      expect(signup).toContain("/app/sign-up?returnTo=");
      expect(authRedirect(signup, true)).toBe(target);
      expect(returnDestination(authPath(signup, "sign-in"))).toBe(target);
      expect(authRedirect(target, true)).toBeNull();
    },
  );

  it("uses the localized job list when no destination is given", () => {
    expect(authRedirect("/app", false)).toBe("/app/sign-in");
    expect(authRedirect("/ko/app/sign-up", true)).toBe("/ko/app");
    expect(authRedirect("/ja/app/sign-in", true)).toBe("/ja/app");
  });

  it.each([
    "https://evil.example/app", "//evil.example/app", "/\\evil.example/app",
    "/app/../../outside", "/api/auth/sign-out", "/app/sign-in", "/ja/app/sign-up?returnTo=/app",
    "/app\n/evil", "javascript:alert(1)", "/apples",
  ])("rejects an unsafe or looping return destination: %s", (target) => {
    expect(returnDestination(`/ko/app/sign-in?returnTo=${encodeURIComponent(target)}`)).toBe("/ko/app");
  });
});
