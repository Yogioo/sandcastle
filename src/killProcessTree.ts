import { spawn, type ChildProcess } from "node:child_process";

/**
 * Force-kill a spawned process and its entire descendant tree.
 *
 * Used when an agent execution is abandoned (idle timeout, completion-grace
 * timeout, user abort). On Windows the agent is launched through
 * cmd.exe/sh wrappers, so killing only the direct child would leak the whole
 * descendant tree (e.g. a hung `find /` under bash under cmd). `taskkill /T`
 * walks the tree; on POSIX we spawn with `detached: true` so the child is a
 * process-group leader and `kill(-pid)` reaches every member.
 *
 * Best-effort: ignores errors (process already exited, permission issues).
 */
export const killProcessTree = (proc: ChildProcess): void => {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.unref();
    } else {
      // Negative pid = the process group the detached child leads.
      process.kill(-proc.pid, "SIGKILL");
    }
  } catch {
    // Already dead or not ours — nothing to do.
  }
};
