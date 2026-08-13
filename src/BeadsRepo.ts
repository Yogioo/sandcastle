import { execSync } from "node:child_process";

export type BeadsCliStatus = "available" | "missing";
export type BeadsDbStatus = "ready" | "missing";

const bd = (repoDir: string | undefined, args: string[]): string =>
  execSync(["bd", ...args].join(" "), {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BD_NON_INTERACTIVE: "1" },
  }).trim();

const bdSucceeds = (repoDir: string | undefined, args: string[]): boolean => {
  try {
    bd(repoDir, args);
    return true;
  } catch {
    return false;
  }
};

/** Whether the host `bd` CLI is on PATH. */
export const inspectBeadsCli = (): BeadsCliStatus =>
  bdSucceeds(undefined, ["version"]) ? "available" : "missing";

/** Whether `repoDir` has a beads workspace `bd` can resolve. */
export const inspectBeadsDb = (repoDir: string): BeadsDbStatus =>
  bdSucceeds(repoDir, ["where"]) ? "ready" : "missing";

/**
 * Initialize a beads database in `repoDir`.
 * Skips AGENTS.md / git-hook setup so sandcastle init only creates the database.
 * `--remote=` (empty) prevents bd from auto-linking the git origin as a Dolt
 * remote, which would otherwise hang on non-beads GitHub remotes.
 */
export const initializeBeadsDb = (repoDir: string): void => {
  bd(repoDir, [
    "init",
    "--non-interactive",
    "--quiet",
    "--skip-agents",
    "--skip-hooks",
    "--init-if-missing",
    "--remote=",
  ]);
};
