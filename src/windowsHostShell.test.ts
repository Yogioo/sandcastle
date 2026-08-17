import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  resolveCursorAgentEntry,
  resolveGitBashPath,
  resolveWindowsHostShell,
} from "./windowsHostShell.js";

const itWindows = process.platform === "win32" ? it : it.skip;

describe("windowsHostShell", () => {
  itWindows("resolveGitBashPath finds Git Bash, not WSL bash", () => {
    const bash = resolveGitBashPath();
    expect(bash).toBeDefined();
    expect(bash!.toLowerCase()).toContain("git");
    expect(bash!.toLowerCase()).toContain("bash.exe");
    expect(bash!.toLowerCase()).not.toContain("system32");
    expect(existsSync(bash!)).toBe(true);
  });

  itWindows("resolveGitBashPath honors SANDCASTLE_GIT_BASH", () => {
    const real = resolveGitBashPath();
    expect(real).toBeDefined();
    const resolved = resolveGitBashPath({
      ...process.env,
      SANDCASTLE_GIT_BASH: real!,
      GIT_BASH_PATH: "C:\\missing\\bash.exe",
    });
    expect(resolved).toBe(real);
  });

  itWindows("resolveWindowsHostShell prefers Git Bash posix mode", () => {
    const shell = resolveWindowsHostShell();
    expect(shell.posix).toBe(true);
    expect(shell.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
  });

  itWindows("resolveWindowsHostShell falls back to cmd.exe without Git Bash", () => {
    const shell = resolveWindowsHostShell({
      ...process.env,
      SANDCASTLE_DISABLE_GIT_BASH: "1",
    });
    expect(shell.posix).toBe(false);
    expect(shell.shellCmd).toBe("cmd.exe");
    expect(shell.shellArgs("echo hi")).toEqual(["/d", "/s", "/c", "echo hi"]);
  });

  itWindows("resolveCursorAgentEntry finds node.exe + index.js", () => {
    const entry = resolveCursorAgentEntry();
    expect(entry).toBeDefined();
    expect(existsSync(entry!.nodePath)).toBe(true);
    expect(existsSync(entry!.indexPath)).toBe(true);
    expect(entry!.nodePath.toLowerCase()).toContain("node.exe");
    expect(entry!.indexPath.toLowerCase()).toContain("index.js");
  });
});
