import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const STATE_DIR_NAME = ".sandcastle";

export interface StateDirectoryEnvironment {
  readonly platform?: NodeJS.Platform | string;
  readonly homeDir?: string;
  readonly localAppData?: string;
  readonly xdgCacheHome?: string;
}

const sanitizeProjectName = (name: string): string => {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return sanitized || "project";
};

const canonicalRepoPath = (repoDir: string): string => {
  const absolute = resolve(repoDir);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

/**
 * Return the user-level cache root used for Sandcastle-owned project state.
 *
 * The path is intentionally persistent rather than based on `os.tmpdir()`.
 * Prompts, credentials, logs, and preserved worktrees must survive a normal
 * reboot and should not disappear during a system temp cleanup.
 */
export const defaultCacheRoot = (
  environment: StateDirectoryEnvironment = {},
): string => {
  const platform = environment.platform ?? process.platform;
  const home = environment.homeDir ?? homedir();

  if (platform === "win32") {
    return (
      environment.localAppData ??
      process.env.LOCALAPPDATA ??
      join(home, "AppData", "Local")
    );
  }

  if (platform === "darwin") {
    return join(home, "Library", "Caches");
  }

  return (
    environment.xdgCacheHome ??
    process.env.XDG_CACHE_HOME ??
    join(home, ".cache")
  );
};

/**
 * Build a stable, human-readable identifier for a repository.
 *
 * The basename makes the directory easy to recognize; the hash prevents two
 * repositories with the same name from sharing state.
 */
export const projectStateId = (repoDir: string): string => {
  const canonical = canonicalRepoPath(repoDir);
  const name = sanitizeProjectName(basename(canonical));
  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return `${name}-${hash}`;
};

/** The default external state directory for a target repository. */
export const defaultStateDir = (
  repoDir: string,
  environment: StateDirectoryEnvironment = {},
): string =>
  join(
    defaultCacheRoot(environment),
    "Sandcastle",
    "projects",
    projectStateId(repoDir),
    STATE_DIR_NAME,
  );

/** Resolve an explicitly supplied state directory against the caller's cwd. */
export const resolveExplicitStateDir = (stateDir: string): string =>
  resolve(process.cwd(), stateDir);

/**
 * Resolve the destination used by `init`.
 *
 * `init` defaults to an external state directory. Supplying `stateDir` is the
 * explicit escape hatch for a custom location.
 */
export const resolveInitStateDir = (
  repoDir: string,
  stateDir?: string,
): string =>
  stateDir ? resolveExplicitStateDir(stateDir) : defaultStateDir(repoDir);

/**
 * Resolve the state directory used by runtime entry points.
 *
 * Runtime callers default to the same per-user cache as `init`. Passing an
 * explicit path remains the escape hatch for custom state locations.
 */
export const resolveRuntimeStateDir = (
  repoDir: string,
  stateDir?: string,
): string =>
  stateDir ? resolveExplicitStateDir(stateDir) : defaultStateDir(repoDir);

/** Resolve CLI state without falling back to a repository-local directory. */
export const resolveCliStateDir = (
  repoDir: string,
  stateDir?: string,
): string =>
  stateDir ? resolveExplicitStateDir(stateDir) : defaultStateDir(repoDir);
