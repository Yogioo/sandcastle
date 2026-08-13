import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

export type ProjectSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Node customization-hook entry that remaps `@yogioo/sandcastle` to this CLI
 * installation. Generated runners live in the per-user cache, so default ESM
 * resolution would look next to the entry file instead of the CLI package.
 */
export const sandcastleRegisterUrl = (): string =>
  new URL("./register-sandcastle.js", import.meta.url).href;

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
 * The entry is intentionally launched as a child process: generated workflow
 * files remain user-editable, while the Sandcastle CLI owns repository cwd,
 * stdio forwarding, and the final exit code.
 */
export const spawnProjectRunner = (
  entryFile: string,
  repoDir: string,
  spawnProcess: ProjectSpawn = spawn,
): Promise<number> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const isWindows = process.platform === "win32";
    const command = isWindows ? process.env.ComSpec || "cmd.exe" : "npx";
    const args = isWindows
      ? ["/d", "/c", "npx.cmd", "tsx", entryFile]
      : ["tsx", entryFile];
    const child = spawnProcess(command, args, {
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
