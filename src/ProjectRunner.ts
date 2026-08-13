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
