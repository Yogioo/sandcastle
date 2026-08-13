import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
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

const isBarePackageSpecifier = (specifier: string): boolean => {
  if (
    specifier.startsWith("node:") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("#") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    isAbsolute(specifier)
  ) {
    return false;
  }
  return specifier.length > 0;
};

const importerIsInside = (
  parentURL: string | undefined,
  root: string,
): boolean => {
  if (!parentURL) return false;
  try {
    const rel = relative(root, fileURLToPath(parentURL));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
};

const parentURLOf = (context: unknown): string | undefined => {
  if (typeof context !== "object" || context === null) return undefined;
  const parentURL = (context as { parentURL?: unknown }).parentURL;
  return typeof parentURL === "string" ? parentURL : undefined;
};

const isModuleNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND";

const withParentURL = (context: unknown, parentURL: string): unknown =>
  typeof context === "object" && context !== null
    ? { ...context, parentURL }
    : { parentURL };

/**
 * Retry bare specifiers from the host repository (`process.cwd()`).
 *
 * Generated runners live in the per-user cache, so default ESM resolution looks
 * next to the entry file and misses host dependencies such as `zod`. Node's
 * `import.meta.resolve(specifier, parent)` second argument is also
 * non-standard and ignored unless `--experimental-import-meta-resolve` is set
 * (Node 20.6+ / 24), so rewriting the generated import is not enough.
 */
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

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    const parentURL = parentURLOf(context);
    const hostParent = pathToFileURL(join(process.cwd(), "package.json")).href;
    if (
      !isBarePackageSpecifier(specifier) ||
      importerIsInside(parentURL, packageRoot) ||
      parentURL === hostParent
    ) {
      throw error;
    }
    // Cache-dir runners cannot see host packages such as zod next to the
    // entry file. Retry against the repository cwd only after default
    // resolution fails, so agent CLIs keep their own node_modules.
    return await nextResolve(specifier, withParentURL(context, hostParent));
  }
}
