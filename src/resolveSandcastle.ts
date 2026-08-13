import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "@yogioo/sandcastle";

const findPackageRoot = (fromUrl: string): string => {
  let dir = dirname(fileURLToPath(fromUrl));
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
        };
        if (pkg.name === PACKAGE_NAME) return dir;
      } catch {
        // Keep walking when package.json is unreadable or malformed.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate the ${PACKAGE_NAME} package root`);
    }
    dir = parent;
  }
};

const packageRoot = findPackageRoot(import.meta.url);

const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as {
  exports?: Record<string, string | { import?: string }>;
};

const exportPath = (subpath: string): string | undefined => {
  const entry = packageJson.exports?.[subpath];
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.import === "string") {
    return entry.import;
  }
  return undefined;
};

/**
 * Map a `@yogioo/sandcastle` specifier to this CLI installation.
 *
 * Generated runners live outside the target repository, so Node would otherwise
 * look for the package next to the entry file or in the target repo. The CLI
 * already has a resolved copy; return its file URL so `sandcastle` works in
 * repos that never installed the package locally.
 */
export const resolveSandcastleSpecifier = (
  specifier: string,
): string | undefined => {
  if (specifier === PACKAGE_NAME) {
    const rel = exportPath(".");
    return rel ? pathToFileURL(join(packageRoot, rel)).href : undefined;
  }
  const prefix = `${PACKAGE_NAME}/`;
  if (!specifier.startsWith(prefix)) return undefined;
  const rel = exportPath(`./${specifier.slice(prefix.length)}`);
  return rel ? pathToFileURL(join(packageRoot, rel)).href : undefined;
};

export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (
    specifier: string,
    context: unknown,
  ) => Promise<{ url: string; shortCircuit?: boolean; format?: string }>,
): Promise<{ url: string; shortCircuit?: boolean; format?: string }> {
  const url = resolveSandcastleSpecifier(specifier);
  if (url !== undefined) {
    return { url, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
