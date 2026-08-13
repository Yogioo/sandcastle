import { describe, expect, it } from "vitest";
import { resolve, resolveSandcastleSpecifier } from "./resolveSandcastle.js";

describe("resolveSandcastleSpecifier", () => {
  it("maps the package name to this installation's root export", () => {
    const url = resolveSandcastleSpecifier("@yogioo/sandcastle");
    expect(url).toMatch(/\/dist\/index\.js$/);
  });

  it("maps sandbox subpaths to this installation", () => {
    const url = resolveSandcastleSpecifier(
      "@yogioo/sandcastle/sandboxes/no-sandbox",
    );
    expect(url).toMatch(/\/dist\/sandboxes\/no-sandbox\.js$/);
  });

  it("leaves unrelated specifiers alone", () => {
    expect(resolveSandcastleSpecifier("zod")).toBeUndefined();
    expect(resolveSandcastleSpecifier("@yogioo/other")).toBeUndefined();
  });
});

describe("resolve hook", () => {
  it("short-circuits Sandcastle specifiers from an unrelated parent", async () => {
    const result = await resolve(
      "@yogioo/sandcastle",
      { parentURL: "file:///tmp/unrelated/.sandcastle/main.mts" },
      () => {
        throw new Error("should not fall through to default resolution");
      },
    );
    expect(result.shortCircuit).toBe(true);
    expect(result.url).toMatch(/\/dist\/index\.js$/);
  });

  it("forwards specifiers that are not this package", async () => {
    const forwarded = await resolve(
      "zod",
      { parentURL: "file:///tmp/x.ts" },
      async () => ({
        url: "file:///tmp/zod.js",
      }),
    );
    expect(forwarded).toEqual({ url: "file:///tmp/zod.js" });
  });
});
