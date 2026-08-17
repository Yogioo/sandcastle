/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-8"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 */

import {
  spawn,
  type StdioOptions,
  type ChildProcess,
} from "node:child_process";
import { createInterface } from "node:readline";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
  InteractiveExecOptions,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { killProcessTree } from "../killProcessTree.js";
import { resolveWindowsHostShell } from "../windowsHostShell.js";

/**
 * Wire an AbortSignal to kill the spawned process tree. The listener is
 * removed once the process closes; aborting after close is a no-op.
 */
const wireKillOnAbort = (
  proc: ChildProcess,
  signal: AbortSignal | undefined,
): void => {
  if (!signal) return;
  if (signal.aborted) {
    killProcessTree(proc);
    return;
  }
  const onAbort = () => killProcessTree(proc);
  signal.addEventListener("abort", onAbort, { once: true });
  proc.once("close", () => signal.removeEventListener("abort", onAbort));
};

export interface NoSandboxOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

type ExecOptions = {
  onLine?: (line: string) => void;
  cwd?: string;
  sudo?: boolean;
  stdin?: string;
  signal?: AbortSignal;
  /**
   * Direct argv spawn (no shell). Used on Windows for Cursor Agent so the
   * prompt is not mangled by `agent.cmd` / cmd.exe quoting.
   */
  argv?: readonly string[];
};

/**
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
export const noSandbox = (options?: NoSandboxOptions): NoSandboxProvider => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions): Promise<NoSandboxHandle> => {
    const worktreePath = createOptions.worktreePath;
    const processEnv = { ...process.env, ...createOptions.env };
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
    const isWindows = process.platform === "win32";
    const windowsShell = isWindows
      ? resolveWindowsHostShell(processEnv)
      : undefined;

    const handle: NoSandboxHandle = {
      worktreePath,

      exec: (command: string, opts?: ExecOptions): Promise<ExecResult> => {
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;
        const argv = opts?.argv;

        return new Promise((resolve, reject) => {
          const proc = argv
            ? spawn(argv[0]!, argv.slice(1), {
                cwd,
                env: processEnv,
                stdio: [
                  opts?.stdin !== undefined ? "pipe" : "ignore",
                  "pipe",
                  "pipe",
                ],
                // Argv mode bypasses the shell; keep the process group semantics
                // used for killProcessTree on POSIX.
                detached: !isWindows,
              })
            : (() => {
                // Windows: prefer Git Bash so POSIX shellEscape quoting works
                // (Cursor / OpenCode / Copilot put prompts on argv). Fall back
                // to cmd.exe when Git Bash is not installed (issue #800).
                const shellCmd = windowsShell?.shellCmd ?? "sh";
                const shellArgs = windowsShell
                  ? windowsShell.shellArgs(command)
                  : ["-c", command];
                return spawn(shellCmd, shellArgs, {
                  cwd,
                  env: processEnv,
                  stdio: [
                    opts?.stdin !== undefined ? "pipe" : "ignore",
                    "pipe",
                    "pipe",
                  ],
                  // cmd.exe needs verbatim args; Git Bash does not.
                  windowsVerbatimArguments:
                    isWindows && windowsShell !== undefined && !windowsShell.posix,
                  detached: !isWindows,
                });
              })();
          wireKillOnAbort(proc, opts?.signal);

          if (opts?.stdin !== undefined) {
            proc.stdin!.write(opts.stdin);
            proc.stdin!.end();
          }

          proc.on("error", (error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          if (opts?.onLine) {
            const onLine = opts.onLine;
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutTail.push(line);
              onLine(line);
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrTail.push(chunk.toString());
            });
            proc.on("close", (code) => {
              resolve({
                stdout: stdoutTail.toString(),
                stderr: stderrTail.toString(),
                exitCode: code ?? 0,
              });
            });
          } else {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            proc.stdout!.on("data", (chunk: Buffer) => {
              stdoutChunks.push(chunk.toString());
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });
            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          }
        });
      },

      interactiveExec: (
        args: string[],
        opts: InteractiveExecOptions,
      ): Promise<{ exitCode: number }> => {
        return new Promise((resolve, reject) => {
          const [cmd, ...rest] = args;
          // Agent CLIs on Windows are typically installed as `.cmd`/`.ps1`
          // npm wrappers; bare `spawn("claude", …)` only resolves `.exe`
          // without `shell: true`, so let cmd.exe handle PATHEXT lookup.
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            shell: process.platform === "win32",
            detached: process.platform !== "win32",
          });
          wireKillOnAbort(proc, opts.signal);

          proc.on("error", (error: Error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on("close", (code: number | null) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },

      close: async (): Promise<void> => {
        // No-op — no container to tear down
      },
    };

    return handle;
  },
});
