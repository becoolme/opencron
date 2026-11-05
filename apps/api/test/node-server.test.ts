import { describe, expect, it } from "vitest";
import { nodeConfig } from "../src/node-config";
import { headersFor, parseHeaders } from "../src/static-headers";
// The real file the web build ships, so a change to it is checked here too.
import headersFile from "../../web/public/_headers?raw";

const secret = "0123456789abcdef0123456789abcdef";
const base = { DATABASE_URL: "postgres://opencron@postgres:5432/opencron", BETTER_AUTH_SECRET: secret };

describe("self-hosted configuration", () => {
  it("starts with a database and an auth secret", () => {
    const { env, port, warnings } = nodeConfig(base);
    expect(env).toMatchObject({ DB_PROVIDER: "postgres", DATABASE_URL: base.DATABASE_URL, APP_URL: "http://localhost:8080" });
    expect(port).toBe(8080);
    expect(warnings).toEqual([expect.stringMatching(/script jobs cannot run/)]);
  });

  it("requires the database and the auth secret", () => {
    expect(() => nodeConfig({ BETTER_AUTH_SECRET: secret })).toThrow(/DATABASE_URL is required/);
    expect(() => nodeConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/BETTER_AUTH_SECRET is required/);
  });

  it.each(["BETTER_AUTH_SECRET", "SANDBOX_TOKEN"])("refuses the example value or a short %s", (key) => {
    expect(() => nodeConfig({ ...base, SANDBOX_URL: "http://sandbox:8787", [key]: "change-me-but-long-enough" }))
      .toThrow(new RegExp(`${key} is a placeholder`));
    expect(() => nodeConfig({ ...base, SANDBOX_URL: "http://sandbox:8787", [key]: "short" }))
      .toThrow(new RegExp(`${key} is a placeholder`));
  });

  it("requires a token when a sandbox is configured", () => {
    expect(() => nodeConfig({ ...base, SANDBOX_URL: "http://sandbox:8787" })).toThrow(/SANDBOX_TOKEN is required/);
    const { env, warnings } = nodeConfig({ ...base, SANDBOX_URL: "http://sandbox:8787", SANDBOX_TOKEN: secret, PORT: "9000" });
    expect(env).toMatchObject({ SANDBOX_URL: "http://sandbox:8787", SANDBOX_TOKEN: secret, APP_URL: "http://localhost:9000" });
    expect(warnings).toEqual([]);
  });
});

describe("web build headers", () => {
  const rules = parseHeaders(headersFile);
  const names = (path: string) => headersFor(rules, path).map(([name]) => name);

  it("puts the security headers on every page", () => {
    for (const path of ["/", "/zh-Hans/jobs/4", "/index.html"]) {
      expect(names(path)).toEqual(expect.arrayContaining([
        "Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy",
      ]));
    }
    expect(headersFor(rules, "/").find(([name]) => name === "Content-Security-Policy")?.[1]).toMatch(/frame-ancestors 'none'/);
  });

  it("caches hashed assets and nothing else", () => {
    expect(names("/assets/index-abc.js")).toContain("Cache-Control");
    expect(names("/")).not.toContain("Cache-Control");
  });

  it("leaves API responses to the API", () => {
    expect(headersFor(rules, "/api/jobs")).toEqual([]);
  });

  it("parses patterns, comments and indented headers", () => {
    expect(parseHeaders("# note\n/exact\n  A: 1\n/pre/*\n  B: x: y\n")).toEqual([
      ["/exact", [["A", "1"]]],
      ["/pre/*", [["B", "x: y"]]],
    ]);
    const parsed = parseHeaders("/exact\n  A: 1\n/pre/*\n  B: 2\n");
    expect(headersFor(parsed, "/exact/more")).toEqual([]);
    expect(headersFor(parsed, "/pre/deep/path")).toEqual([["B", "2"]]);
  });
});
