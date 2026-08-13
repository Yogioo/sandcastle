import { execFileSync } from "node:child_process";

export type GitRepoStatus = "ready" | "missing" | "unborn";

const git = (repoDir: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim();

const gitSucceeds = (repoDir: string, args: string[]): boolean => {
  try {
    git(repoDir, args);
    return true;
  } catch {
    return false;
  }
};

/** Whether `repoDir` is a git work tree with at least one commit. */
export const inspectGitRepo = (repoDir: string): GitRepoStatus => {
  if (!gitSucceeds(repoDir, ["rev-parse", "--is-inside-work-tree"])) {
    return "missing";
  }
  if (!gitSucceeds(repoDir, ["rev-parse", "--verify", "HEAD"])) {
    return "unborn";
  }
  return "ready";
};

/**
 * Create a git repository (if needed) and an empty initial commit so HEAD exists.
 * Local `user.name` / `user.email` are set only when missing, so a commit can succeed
 * on machines with no global git identity.
 */
export const initializeGitRepo = (repoDir: string): void => {
  if (inspectGitRepo(repoDir) === "missing") {
    git(repoDir, ["init", "-b", "main"]);
  }
  if (!gitSucceeds(repoDir, ["config", "--get", "user.email"])) {
    git(repoDir, ["config", "user.email", "sandcastle@localhost"]);
  }
  if (!gitSucceeds(repoDir, ["config", "--get", "user.name"])) {
    git(repoDir, ["config", "user.name", "Sandcastle"]);
  }
  git(repoDir, ["commit", "--allow-empty", "-m", "Initial commit"]);
};
