import { Deferred, Duration, Effect, Fiber } from "effect";
import { AgentStreamEmitter } from "./AgentStreamEmitter.js";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  SessionCaptureError,
} from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory, SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type { AgentProvider, IterationUsage } from "./AgentProvider.js";
import type { Timeouts } from "./run.js";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";

export type { ParsedStreamEvent, IterationUsage } from "./AgentProvider.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;

const DEFAULT_AGENT_RESTART_LIMIT = 2;
const DEFAULT_AGENT_RESTART_DELAY_MS = 15_000;
const CARRYOVER_MAX_LINES = 200;
const CARRYOVER_MAX_CHARS = 16_000;

/** Tail of a failed attempt's output, injected into the restart prompt. */
const buildCarryOver = (output: string): string => {
  const tail = output.split("\n").slice(-CARRYOVER_MAX_LINES).join("\n");
  return tail.length > CARRYOVER_MAX_CHARS
    ? `…${tail.slice(-CARRYOVER_MAX_CHARS)}`
    : tail;
};

/** Restart prompt: original prompt + the previous attempt's output. */
const buildRestartPrompt = (
  originalPrompt: string,
  previousOutput: string,
  idleTimeoutMs: number | null,
): string => {
  const carryOver = buildCarryOver(previousOutput);
  const progress =
    carryOver.trim() === ""
      ? "(the previous attempt produced no output before it was terminated)"
      : carryOver;
  const idleDuration =
    idleTimeoutMs === null
      ? "an extended period"
      : `${idleTimeoutMs / 1000} seconds`;
  return `${originalPrompt}\n\n<previous_attempt>\nYour previous attempt was terminated because no output was received for ${idleDuration} (idle timeout), and the process was killed. Your session context is gone, but the workspace state persists. Continue the task from where you left off — do not redo work that was already completed or verified.\n\nLast output from the previous attempt:\n---\n${progress}\n---\n</previous_attempt>`;
};

type InvokeAgentResult = {
  readonly result: string;
  readonly sessionId?: string;
  readonly usage?: IterationUsage;
  /** Set when the outer AbortSignal won the race; caller must re-throw reason. */
  readonly aborted?: {
    readonly reason: unknown;
  };
};

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  provider: AgentProvider,
  idleTimeoutMs: number | null,
  completionTimeoutMs: number,
  completionSignals: readonly string[],
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
  onRawLine: (line: string) => void,
  onIdleWarning: (minutes: number) => void,
  onCompletionTimeout: (timeoutMs: number) => void,
  idleWarningIntervalMs: number = IDLE_WARNING_INTERVAL_MS,
  resumeSession?: string,
  forkSession?: boolean,
  signal?: AbortSignal,
  restartLimit: number = DEFAULT_AGENT_RESTART_LIMIT,
  restartDelayMs: number = DEFAULT_AGENT_RESTART_DELAY_MS,
  onRestart: (attempt: number, maxAttempts: number) => void = () => {},
  onSessionId: (sessionId: string) => void = () => {},
): Effect.Effect<InvokeAgentResult, SandboxError> =>
  Effect.gen(function* () {
    // Accumulated output of the *previous* attempt, consumed to build the
    // restart prompt and reset at the start of each attempt. Within an attempt
    // it also holds the text/result scanned for the completion signal so a
    // hanging process can be force-completed once the signal is in the buffer
    // (see ADR 0019).
    let accumulatedOutput = "";
    const maxAttempts = restartLimit + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptPrompt =
        attempt === 1
          ? prompt
          : buildRestartPrompt(prompt, accumulatedOutput, idleTimeoutMs);
      accumulatedOutput = "";
      let resultText = "";
      let sessionId: string | undefined;
      let usage: IterationUsage | undefined;

      // Deferred that fails when the idle timer fires (no signal seen).
      const timeoutSignal = yield* Deferred.make<
        never,
        AgentIdleTimeoutError
      >();
      // Deferred that resolves successfully when the completion-grace timer
      // fires (signal seen but process hasn't exited). Resolving lets the race
      // hand control back to the orchestrator with the buffered output, which
      // still contains the signal so the existing completionSignal check works.
      const completionTimeoutDeferred = yield* Deferred.make<
        { result: string; sessionId?: string; usage?: IterationUsage },
        never
      >();
      let timeoutFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
      let completionDetected = false;

      // Periodic idle warning state
      let warningFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
      let idleMinuteCounter = 0;

      const interruptFiber = (
        fiber: Fiber.RuntimeFiber<unknown, unknown> | null,
      ) => {
        if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
      };

      const startWarningInterval = () => {
        interruptFiber(warningFiber);
        idleMinuteCounter = 0;
        warningFiber = Effect.runFork(
          Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(Duration.millis(idleWarningIntervalMs));
              idleMinuteCounter++;
              onIdleWarning(idleMinuteCounter);
            }
          }),
        );
      };

      const resetTimer = () => {
        interruptFiber(timeoutFiber);
        if (completionDetected) {
          // Post-signal grace window — successful resolution on expiry.
          timeoutFiber = Effect.runFork(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(completionTimeoutMs));
              onCompletionTimeout(completionTimeoutMs);
              yield* Deferred.succeed(completionTimeoutDeferred, {
                result: resultText || accumulatedOutput,
                sessionId,
                usage,
              });
            }),
          );
        } else if (idleTimeoutMs !== null) {
          // Pre-signal idle window — failure on expiry. Skipped entirely when
          // the idle timeout is disabled (idleTimeoutMs === null), so the
          // agent may run indefinitely without producing output.
          timeoutFiber = Effect.runFork(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(idleTimeoutMs));
              yield* Deferred.fail(
                timeoutSignal,
                new AgentIdleTimeoutError({
                  message: `Agent idle for ${idleTimeoutMs / 1000} seconds — no output received. Consider raising idleTimeoutSeconds (or omitting it to disable the idle timeout entirely).`,
                  timeoutMs: idleTimeoutMs,
                }),
              );
            }),
          );
          // Reset warning interval on activity, idle-phase only.
          startWarningInterval();
        }
      };

      // Deferred that resolves when the AbortSignal fires. We succeed (not
      // die) so the caller can best-effort captureToHost with the sessionId
      // already observed on the stream, then re-throw signal.reason (ADR 0004).
      const abortDeferred = yield* Deferred.make<InvokeAgentResult, never>();
      let abortCleanup: (() => void) | null = null;
      if (signal) {
        if (signal.aborted) {
          return yield* Effect.die(signal.reason);
        }
        const onAbort = () => {
          Effect.runFork(
            Deferred.succeed(abortDeferred, {
              result: resultText || accumulatedOutput,
              sessionId,
              usage,
              aborted: { reason: signal.reason },
            }),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }

      // Abort controller wired into exec: whenever this attempt's fiber is
      // abandoned (idle timeout, completion-grace resolution, outer abort), the
      // exec layer kills the agent process tree so no orphaned processes
      // survive the timeout (see killProcessTree).
      const abortController = new AbortController();
      resetTimer();

      const execEffect = Effect.gen(function* () {
        const printCmd = provider.buildPrintCommand({
          prompt: attemptPrompt,
          dangerouslySkipPermissions: true,
          resumeSession,
          forkSession,
        });
        const execResult = yield* sandbox.exec(printCmd.command, {
          onLine: (line) => {
            // Surface the raw line FIRST so verbose mode/forwarders see every
            // stdout line the agent produced, including ones parseStreamLine
            // drops. Errors thrown by the callback are caught by the emitter
            // layer; isolate the parser path here so a broken forwarder cannot
            // skip parsing.
            try {
              onRawLine(line);
            } catch {
              // Swallow — must not skip parsing/timer logic below.
            }
            for (const parsed of provider.parseStreamLine(line)) {
              if (parsed.type === "text") {
                onText(parsed.text);
                accumulatedOutput += parsed.text;
              } else if (parsed.type === "result") {
                resultText = parsed.result;
                accumulatedOutput += parsed.result;
              } else if (parsed.type === "tool_call") {
                onToolCall(parsed.name, parsed.args);
              } else if (parsed.type === "session_id") {
                sessionId = parsed.sessionId;
                onSessionId(parsed.sessionId);
              } else if (parsed.type === "usage") {
                usage = parsed.usage;
              }
            }
            // Check for the completion signal AFTER parsing this line so the
            // accumulator contains everything seen so far. Flip to the
            // completion-grace timer the first time the signal appears.
            if (
              !completionDetected &&
              completionSignals.some((sig) => accumulatedOutput.includes(sig))
            ) {
              completionDetected = true;
              interruptFiber(warningFiber);
              warningFiber = null;
            }
            resetTimer();
          },
          cwd: sandboxRepoDir,
          stdin: printCmd.stdin,
          argv: printCmd.argv,
          signal: abortController.signal,
        });

        if (execResult.exitCode !== 0) {
          // Prefer stderr; fall back to resultText (from parsed stream events),
          // then to the tail of raw stdout (last 20 non-empty lines).
          let errorDetail = execResult.stderr;
          if (!errorDetail.trim()) {
            errorDetail = resultText;
          }
          if (!errorDetail.trim()) {
            const lines = execResult.stdout.split("\n").filter((l) => l.trim());
            errorDetail = lines.slice(-20).join("\n");
          }
          return yield* Effect.fail(
            new AgentError({
              message: `${provider.name} exited with code ${execResult.exitCode}:\n${errorDetail}`,
            }),
          );
        }

        return { result: resultText || execResult.stdout, sessionId, usage };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            interruptFiber(timeoutFiber);
            timeoutFiber = null;
            interruptFiber(warningFiber);
            warningFiber = null;
          }),
        ),
        Effect.onInterrupt(() => Effect.sync(() => abortController.abort())),
      );

      let raced: Effect.Effect<
        InvokeAgentResult,
        AgentIdleTimeoutError | SandboxError
      > = Effect.raceFirst(execEffect, Deferred.await(timeoutSignal));
      raced = Effect.raceFirst(
        raced,
        Deferred.await(completionTimeoutDeferred),
      );
      if (signal) {
        raced = Effect.raceFirst(raced, Deferred.await(abortDeferred));
      }

      const outcome = yield* Effect.either(
        raced.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              interruptFiber(timeoutFiber);
              timeoutFiber = null;
              interruptFiber(warningFiber);
              warningFiber = null;
            }),
          ),
        ),
      );
      if (outcome._tag === "Right") {
        abortCleanup?.();
        return outcome.right;
      }
      const error = outcome.left;
      if (error instanceof AgentIdleTimeoutError && attempt < maxAttempts) {
        // The process tree was already killed via the abort signal; carry the
        // attempt's output into the next attempt's prompt and retry.
        onRestart(attempt + 1, maxAttempts);
        yield* Effect.sleep(Duration.millis(restartDelayMs));
        continue;
      }
      abortCleanup?.();
      return yield* Effect.fail(error);
    }
    // Unreachable — the loop only exits via return above.
    return yield* Effect.fail(
      new AgentIdleTimeoutError({
        message: "unreachable",
        timeoutMs: idleTimeoutMs ?? 0,
      }),
    );
  });

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60;

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly provider: AgentProvider;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails with AgentIdleTimeoutError. Default: 600 (10 minutes) */
  readonly idleTimeoutSeconds?: number;
  /**
   * Max automatic restarts of the agent process after an idle timeout.
   * Each restart re-launches the agent with the previous attempt's output
   * appended to the prompt, so progress made before the hang is not lost.
   * The process tree is force-killed before every restart. Default: 2
   * (3 attempts total). Set to 0 to fail immediately on the first timeout.
   */
  readonly agentRestartLimit?: number;
  /**
   * Delay between restart attempts, in milliseconds. Default: 15000 (15s).
   * @internal Mostly for tests; the default is fine for real runs.
   */
  readonly agentRestartDelayMs?: number;
  /**
   * Grace window in seconds after a completion signal is observed in the
   * agent's output. The agent process is expected to exit shortly after
   * emitting the signal; if it does not (because a spawned child is keeping
   * stdout open — see ADR 0019), this timer fires and the iteration resolves
   * successfully with the buffered output. Resets on every subsequent output
   * line, so trailing data (token-usage events, terminal `result` events,
   * structured-output tags) is still captured. Default: 60 seconds.
   */
  readonly completionTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
  /** Resume a prior Claude Code session by ID. Applied to iteration 1 only. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it — the parent JSONL stays intact and the agent writes a new session
   * under a fresh id. Applied to iteration 1 only. See ADR 0018.
   */
  readonly forkSession?: boolean;
  /** An AbortSignal that cancels the orchestration when aborted. */
  readonly signal?: AbortSignal;
  /** When true, skip prompt expansion (shell expression evaluation). Set for dynamic inline prompts. */
  readonly skipPromptExpansion?: boolean;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** Forwarded to `withSandboxLifecycle` — see `SandboxLifecycleOptions.keepSourceBranch`. */
  readonly keepSourceBranch?: boolean;
}

/** Per-iteration result carrying an optional session ID. */
export interface IterationResult {
  /** Claude Code session ID extracted from the init line, or undefined for non-Claude agents. */
  readonly sessionId?: string;
  /** Absolute host path to the captured session JSONL, or undefined when capture is disabled or provider is non-Claude. */
  readonly sessionFilePath?: string;
  /** Token usage snapshot from the last assistant message in the session, or undefined when capture is disabled or provider does not support usage parsing. */
  readonly usage?: IterationUsage;
}

export interface OrchestrateResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly branch: string;
  /** Host path to the preserved worktree from the last iteration, set when the worktree was left behind due to uncommitted changes on a successful run. */
  readonly preservedWorktreePath?: string;
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<
  OrchestrateResult,
  SandboxError,
  SandboxFactory | Display | AgentStreamEmitter
> => {
  // Idle timeout is opt-in. Omitted (or <= 0) means disabled: the agent may
  // run indefinitely without producing output and is never killed for being
  // idle. A positive value re-enables the classic limit (seconds of silence
  // before the iteration fails and the agent auto-restarts).
  const idleTimeoutMs =
    options.idleTimeoutSeconds !== undefined && options.idleTimeoutSeconds > 0
      ? options.idleTimeoutSeconds * 1000
      : null;
  const completionTimeoutMs =
    (options.completionTimeoutSeconds ?? DEFAULT_COMPLETION_TIMEOUT_SECONDS) *
    1000;
  const agentRestartLimit =
    options.agentRestartLimit ?? DEFAULT_AGENT_RESTART_LIMIT;
  const agentRestartDelayMs =
    options.agentRestartDelayMs ?? DEFAULT_AGENT_RESTART_DELAY_MS;
  return Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const streamEmitter = yield* AgentStreamEmitter;
    const { hostRepoDir, iterations, hooks, prompt, branch, provider } =
      options;
    let completionSignals: string[];
    if (options.completionSignal === undefined) {
      completionSignals = [DEFAULT_COMPLETION_SIGNAL];
    } else if (Array.isArray(options.completionSignal)) {
      completionSignals = options.completionSignal;
    } else {
      completionSignals = [options.completionSignal];
    }

    const label = (msg: string): string =>
      options.name ? `[${options.name}] ${msg}` : msg;

    const allCommits: { sha: string }[] = [];
    const allIterations: IterationResult[] = [];
    let allStdout = "";
    let resolvedBranch = "";
    let iterationPreservedPath: string | undefined;

    // Helper: check abort signal and bail via defect so run() can
    // re-throw the signal's reason verbatim (no Sandcastle wrapping).
    const checkAbort = (): Effect.Effect<void> =>
      options.signal?.aborted ? Effect.die(options.signal.reason) : Effect.void;

    for (let i = 1; i <= iterations; i++) {
      yield* checkAbort();
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      const sandboxResult = yield* factory.withSandbox(
        (
          { hostWorktreePath, sandboxRepoPath, applyToHost, bindMountHandle },
          sandbox,
        ) =>
          withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir: sandboxRepoPath,
              hooks,
              branch,
              hostWorktreePath,
              applyToHost,
              signal: options.signal,
              timeouts: options.timeouts,
              keepSourceBranch: options.keepSourceBranch,
            },
            sandbox,
            (ctx) =>
              Effect.gen(function* () {
                // Resume session: transfer JSONL from host to sandbox before iteration 1
                const iterationResumeSession =
                  i === 1 ? options.resumeSession : undefined;
                const iterationForkSession =
                  i === 1 ? options.forkSession : undefined;
                if (
                  iterationResumeSession &&
                  bindMountHandle &&
                  provider.sessionStorage
                ) {
                  yield* display.status(label("Resuming session"), "info");
                  yield* Effect.tryPromise({
                    try: () =>
                      provider.sessionStorage!.resumeIntoSandbox({
                        hostCwd: hostRepoDir,
                        sandboxCwd: ctx.sandboxRepoDir,
                        sessionId: iterationResumeSession,
                        handle: bindMountHandle,
                      }),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session resume failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId: iterationResumeSession,
                      }),
                  });
                }

                // Preprocess prompt (run !`command` expressions inside sandbox).
                // Inline prompts pass through literally — skip expansion.
                const fullPrompt = options.skipPromptExpansion
                  ? prompt
                  : yield* preprocessPrompt(
                      prompt,
                      ctx.sandbox,
                      ctx.sandboxRepoDir,
                    );

                yield* display.status(label("Agent started"), "success");

                // Invoke the agent — buffer text deltas so Pi's single-token
                // chunks are displayed as readable multi-word lines.
                const textBuffer = new TextDeltaBuffer((chunk) => {
                  Effect.runPromise(display.textChunk(chunk));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "text",
                      message: chunk,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                });
                const onText = (text: string) => {
                  textBuffer.write(text);
                };
                const onToolCall = (name: string, formattedArgs: string) => {
                  textBuffer.flush();
                  Effect.runPromise(display.toolCall(name, formattedArgs));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "toolCall",
                      name,
                      formattedArgs,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onRawLine = (line: string) => {
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "raw",
                      line,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onIdleWarning = (minutes: number) => {
                  const msg =
                    minutes === 1
                      ? "Agent idle for 1 minute"
                      : `Agent idle for ${minutes} minutes`;
                  Effect.runPromise(display.status(label(msg), "warn"));
                };
                const onCompletionTimeout = (timeoutMs: number) => {
                  Effect.runPromise(
                    display.status(
                      label(
                        `Completion signal seen but agent process is hanging — force-completing after ${timeoutMs / 1000}s grace window.`,
                      ),
                      "warn",
                    ),
                  );
                };
                const {
                  result: agentOutput,
                  sessionId,
                  usage: streamUsage,
                  aborted,
                } = yield* invokeAgent(
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                  fullPrompt,
                  provider,
                  idleTimeoutMs,
                  completionTimeoutMs,
                  completionSignals,
                  onText,
                  onToolCall,
                  onRawLine,
                  onIdleWarning,
                  onCompletionTimeout,
                  options._idleWarningIntervalMs,
                  iterationResumeSession,
                  iterationForkSession,
                  options.signal,
                  agentRestartLimit,
                  agentRestartDelayMs,
                  (attempt, maxAttempts) => {
                    Effect.runPromise(
                      display.status(
                        label(
                          `Agent idle — killing and restarting (attempt ${attempt}/${maxAttempts}) with carried-over context.`,
                        ),
                        "warn",
                      ),
                    );
                  },
                  (observedSessionId) => {
                    Effect.runPromise(
                      streamEmitter.emit({
                        type: "sessionId",
                        sessionId: observedSessionId,
                        iteration: i,
                        timestamp: new Date(),
                      }),
                    );
                  },
                );

                // Flush any remaining buffered text deltas
                textBuffer.dispose();

                // Best-effort session capture on abort so pause/append can
                // resumeSession. Always re-throw signal.reason (ADR 0004).
                if (aborted) {
                  if (
                    provider.captureSessions &&
                    provider.sessionStorage &&
                    sessionId &&
                    bindMountHandle
                  ) {
                    yield* Effect.promise(() =>
                      provider
                        .sessionStorage!.captureToHost({
                          hostCwd: hostRepoDir,
                          sandboxCwd: ctx.sandboxRepoDir,
                          sessionId,
                          handle: bindMountHandle,
                        })
                        .catch(() => {
                          // Best-effort: capture failure must not mask abort.
                        }),
                    );
                  }
                  return yield* Effect.die(aborted.reason);
                }

                yield* display.status(label("Agent stopped"), "info");

                // Capture session while sandbox is still alive. Usage from the
                // stream (e.g. Codex's turn.completed) is the baseline; a
                // session-parsed value below overrides it when available.
                let sessionFilePath: string | undefined;
                let usage: IterationUsage | undefined = streamUsage;
                if (
                  provider.captureSessions &&
                  provider.sessionStorage &&
                  sessionId &&
                  bindMountHandle
                ) {
                  yield* display.status(label("Capturing session"), "info");
                  yield* Effect.tryPromise({
                    try: () =>
                      provider.sessionStorage!.captureToHost({
                        hostCwd: hostRepoDir,
                        sandboxCwd: ctx.sandboxRepoDir,
                        sessionId,
                        handle: bindMountHandle,
                      }),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session capture failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId,
                      }),
                  });
                  sessionFilePath = provider.sessionStorage.hostSessionFilePath(
                    hostRepoDir,
                    sessionId,
                  );

                  // Parse token usage from the captured session JSONL
                  if (provider.parseSessionUsage) {
                    const content = yield* Effect.promise(() =>
                      provider
                        .sessionStorage!.readHostSession(hostRepoDir, sessionId)
                        .catch(() => undefined as string | undefined),
                    );
                    if (content) {
                      const parsedUsage = provider.parseSessionUsage(content);
                      if (parsedUsage) usage = parsedUsage;
                    }
                  }
                }

                // Check completion signal
                const matchedSignal = completionSignals.find((sig) =>
                  agentOutput.includes(sig),
                );
                return {
                  completionSignal: matchedSignal,
                  stdout: agentOutput,
                  sessionId,
                  sessionFilePath,
                  usage,
                } as const;
              }),
          ),
      );

      const lifecycleResult = sandboxResult.value;
      iterationPreservedPath = sandboxResult.preservedWorktreePath;

      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;

      allIterations.push({
        sessionId: lifecycleResult.result.sessionId,
        sessionFilePath: lifecycleResult.result.sessionFilePath,
        usage: lifecycleResult.result.usage,
      });

      if (lifecycleResult.result.completionSignal !== undefined) {
        yield* display.status(
          label(`Agent signaled completion after ${i} iteration(s).`),
          "success",
        );
        return {
          iterations: allIterations,
          completionSignal: lifecycleResult.result.completionSignal,
          stdout: allStdout,
          commits: allCommits,
          branch: resolvedBranch,
          preservedWorktreePath: iterationPreservedPath,
        };
      }
    }

    yield* display.status(
      label(`Reached max iterations (${iterations}).`),
      "info",
    );
    return {
      iterations: allIterations,
      completionSignal: undefined,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
      preservedWorktreePath: iterationPreservedPath,
    };
  });
};
