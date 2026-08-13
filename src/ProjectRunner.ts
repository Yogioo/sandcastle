import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type ProjectSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Node customization-hook entry that remaps `@yogioo/sandcastle` (and host
 * packages such as `zod`) for generated runners in the per-user cache.
 */
export const sandcastleRegisterUrl = (): string =>
  new URL("./register-sandcastle.js", import.meta.url).href;

export const tsxCliPath = (): string => {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
};

/**
 * Attach the resolve hook via NODE_OPTIONS. tsx re-execs itself and drops
 * argv `--import` flags, so the hook must live in the environment to apply
 * to the runner. Agent CLIs inherit this too; the hook tries default
 * resolution first so their own packages are not stolen.
 */
export const withSandcastleResolveHook = (
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const flag = `--import=${sandcastleRegisterUrl()}`;
  const existing = env.NODE_OPTIONS?.trim();
  if (existing?.includes(flag)) {
    return { ...env };
  }
  return {
    ...env,
    NODE_OPTIONS: existing ? `${existing} ${flag}` : flag,
  };
};

/**
 * Execute a generated project entry file through the package's CLI runtime.
 *
 * Spawn `node <tsx> <entry>` directly. `npx.cmd tsx` on Windows can exit 1
 * with no output when a customization hook is registered, so the CLI package
 * depends on `tsx` and invokes it without npx.
 */
export const spawnProjectRunner = (
  entryFile: string,
  repoDir: string,
  spawnProcess: ProjectSpawn = spawn,
): Promise<number> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnProcess(process.execPath, [tsxCliPath(), entryFile], {
      cwd: repoDir,
      stdio: "inherit",
      env: withSandcastleResolveHook(),
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    });
  });
