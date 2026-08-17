/**
 * Windows host helpers for no-sandbox execution.
 *
 * Stock Windows shells (cmd.exe / PowerShell) do not honor POSIX `shellEscape`
 * quoting. Prefer Git Bash when present. Cursor Agent's `agent.cmd` wrapper
 * also mangles multiline argv via `%*`, so print-mode launches should spawn
 * the underlying `node.exe` + `index.js` directly when possible.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Resolve Git Bash (`bash.exe`), never the WSL launcher in System32. */
export const resolveGitBashPath = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  // Test / opt-out escape hatch — forces the cmd.exe fallback path.
  if (env.SANDCASTLE_DISABLE_GIT_BASH === "1") return undefined;

  const explicit = env.SANDCASTLE_GIT_BASH ?? env.GIT_BASH_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const roots = [
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : undefined,
  ].filter((root): root is string => typeof root === "string" && root.length > 0);

  for (const root of roots) {
    const candidate = join(root, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }

  try {
    const whereOut = execFileSync("where.exe", ["git"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of whereOut.split(/\r?\n/)) {
      const gitPath = line.trim();
      if (!gitPath) continue;
      const candidates = [
        // Git\cmd\git.exe → Git\bin\bash.exe
        join(dirname(gitPath), "..", "bin", "bash.exe"),
        // Git\bin\git.exe → Git\bin\bash.exe
        join(dirname(gitPath), "bash.exe"),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // `where.exe git` failed — no Git on PATH.
  }

  return undefined;
};

/**
 * Parse Cursor Agent version directory names for newest-first sort.
 * Supports `YYYY.MM.DD-commit` and `YYYY.MM.DD-HH-MM-SS-commit`.
 */
const cursorVersionSortKey = (name: string): number => {
  const datePart = name.split("-")[0] ?? "";
  const parts = datePart.split(".");
  if (parts.length !== 3) return 0;
  const year = parts[0] ?? "0";
  const month = (parts[1] ?? "0").padStart(2, "0");
  const day = (parts[2] ?? "0").padStart(2, "0");
  return Number(year + month + day);
};

export interface CursorAgentEntry {
  readonly nodePath: string;
  readonly indexPath: string;
}

/**
 * Locate Cursor Agent's real Node entrypoint, bypassing `agent.cmd`.
 * Returns undefined when the install layout cannot be found.
 */
export const resolveCursorAgentEntry = (
  env: NodeJS.ProcessEnv = process.env,
): CursorAgentEntry | undefined => {
  const roots: string[] = [];
  for (const dir of (env.PATH ?? "").split(";")) {
    if (!dir) continue;
    if (existsSync(join(dir, "agent.cmd"))) {
      roots.push(dir);
      break;
    }
  }
  if (env.LOCALAPPDATA) {
    roots.push(join(env.LOCALAPPDATA, "cursor-agent"));
  }

  for (const root of roots) {
    const directNode = join(root, "node.exe");
    const directIndex = join(root, "index.js");
    if (existsSync(directNode) && existsSync(directIndex)) {
      return { nodePath: directNode, indexPath: directIndex };
    }

    const versionsDir = join(root, "versions");
    if (!existsSync(versionsDir)) continue;

    const versions = readdirSync(versionsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i.test(
            entry.name,
          ),
      )
      .map((entry) => entry.name)
      .sort((a, b) => cursorVersionSortKey(b) - cursorVersionSortKey(a));

    for (const version of versions) {
      const nodePath = join(versionsDir, version, "node.exe");
      const indexPath = join(versionsDir, version, "index.js");
      if (existsSync(nodePath) && existsSync(indexPath)) {
        return { nodePath, indexPath };
      }
    }
  }

  return undefined;
};

export interface WindowsHostShell {
  readonly shellCmd: string;
  readonly shellArgs: (command: string) => string[];
  /** True when the shell is Git Bash (POSIX quoting / `$VAR` expansion). */
  readonly posix: boolean;
}

/**
 * Pick the host shell for Windows no-sandbox `exec`.
 * Prefers Git Bash so `shellEscape` single-quotes work; falls back to cmd.exe.
 */
export const resolveWindowsHostShell = (
  env: NodeJS.ProcessEnv = process.env,
): WindowsHostShell => {
  const gitBash = resolveGitBashPath(env);
  if (gitBash) {
    return {
      shellCmd: gitBash,
      shellArgs: (command) => ["-c", command],
      posix: true,
    };
  }
  return {
    shellCmd: "cmd.exe",
    shellArgs: (command) => ["/d", "/s", "/c", command],
    posix: false,
  };
};
