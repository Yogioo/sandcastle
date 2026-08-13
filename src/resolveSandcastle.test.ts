import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolve, resolveSandcastleSpecifier } from "./resolveSandcastle.js";

const nodeLikeResolve = async (
  specifier: string,
  context: unknown,
): Promise<{ url: string }> => {
  const parent = (context as { parentURL?: string }).parentURL;
  if (!parent) {
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  }
  try {
    const require = createRequire(fileURLToPath(parent));
    return { url: pathToFileURL(require.resolve(specifier)).href };
  } catch {
    throw Object.assign(
      new Error(`Cannot find package '${specifier}' imported from ${parent}`),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
  }
};

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

  it("forwards specifiers that are not this package and are not in the host", async () => {
    const forwarded = await resolve(
      "package-that-does-not-exist-sandcastle-xyz",
      { parentURL: "file:///tmp/x.ts" },
      async () => ({
        url: "file:///tmp/missing.js",
      }),
    );
    expect(forwarded).toEqual({ url: "file:///tmp/missing.js" });
  });

  it("does not remap host packages for importers inside this CLI package", async () => {
    const forwarded = await resolve(
      "zod",
      { parentURL: import.meta.url },
      async () => ({ url: "file:///cli-internal-zod.js" }),
    );
    expect(forwarded).toEqual({ url: "file:///cli-internal-zod.js" });
  });

  it("resolves zod from the host package when the importer lives in the cache directory", async () => {
    const result = await resolve(
      "zod",
      {
        parentURL:
          "file:///C:/Users/EDY/AppData/Local/Sandcastle/projects/example/.sandcastle/main.ts",
      },
      nodeLikeResolve,
    );
    expect(result.url).toMatch(/node_modules\/zod/);
  });

  it("falls back to the original parent when the host does not have the package", async () => {
    await expect(
      resolve(
        "package-that-does-not-exist-sandcastle-xyz",
        {
          parentURL:
            "file:///C:/Users/EDY/AppData/Local/Sandcastle/projects/example/.sandcastle/main.ts",
        },
        nodeLikeResolve,
      ),
    ).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
  });
});
