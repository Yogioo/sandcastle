// Loop + agent control for the implement workflow.
//
// Commands (commands.jsonl) and inbox/append.txt are polled while an agent
// runs. Append and pause_agent abort the current run(); after abort the
// caller resumes via resumeSession (append immediately, pause_agent after
// resume_agent). pause_loop / resume_loop gate the outer while-loop.

import type { ControlCommand, Runtime, RuntimeState } from "./runtime.js";

export type AbortAction =
  | { kind: "append"; text: string }
  | { kind: "pause_agent" }
  | { kind: "pause_loop" };

export type LoopController = {
  /** AbortSignal for the in-flight agent run (fresh per beginAgent). */
  currentSignal: () => AbortSignal | undefined;
  beginAgent: (
    agent: NonNullable<RuntimeState["agent"]>,
    phase: "implement" | "review",
    patch?: Partial<RuntimeState>,
  ) => AbortSignal;
  endAgent: (patch?: Partial<RuntimeState>) => void;
  noteSessionId: (sessionId: string) => void;
  sessionId: () => string | undefined;
  /** True when this error is our control-plane abort (not a foreign throw). */
  isControlAbort: (error: unknown) => boolean;
  /**
   * After a control abort, returns why we aborted (append / pause_agent /
   * pause_loop). Clears the pending action.
   */
  takeAbortAction: () => AbortAction | null;
  /** Block while pause_loop is in effect (polls commands). */
  waitWhileLoopPaused: () => Promise<void>;
  /** Block until resume_agent after pause_agent (returns optional prompt). */
  waitForResumeAgent: () => Promise<string>;
  /** Poll inbox + commands once; may abort the current agent. */
  poll: () => void;
  /** Start background polling while an agent runs. */
  startPolling: (intervalMs?: number) => void;
  stopPolling: () => void;
  close: () => void;
};

const CONTROL_ABORT = Symbol.for("sandcastle.controlAbort");

type ControlAbortReason = {
  readonly [CONTROL_ABORT]: true;
  readonly action: AbortAction;
};

const isControlAbortReason = (value: unknown): value is ControlAbortReason =>
  typeof value === "object" &&
  value !== null &&
  (value as { [CONTROL_ABORT]?: boolean })[CONTROL_ABORT] === true;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createLoopController = (runtime: Runtime): LoopController => {
  let abortController: AbortController | undefined;
  let pendingAction: AbortAction | null = null;
  let loopPaused = false;
  let agentPaused = false;
  let resumeAgentPrompt: string | undefined;
  let lastSessionId: string | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const stopPolling = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const applyCommands = (commands: ControlCommand[]): void => {
    for (const cmd of commands) {
      switch (cmd.type) {
        case "pause_loop":
          loopPaused = true;
          if (abortController && !abortController.signal.aborted) {
            pendingAction = { kind: "pause_loop" };
            runtime.writeState({ status: "pausing" });
            abortController.abort({
              [CONTROL_ABORT]: true,
              action: pendingAction,
            } satisfies ControlAbortReason);
          } else {
            runtime.writeState({
              phase: "paused",
              status: "paused",
              agent: null,
            });
          }
          break;
        case "resume_loop":
          loopPaused = false;
          if (runtime.readState().phase === "paused") {
            runtime.writeState({ phase: "idle", status: "running" });
          }
          break;
        case "pause_agent":
          if (abortController && !abortController.signal.aborted) {
            pendingAction = { kind: "pause_agent" };
            agentPaused = true;
            runtime.writeState({ status: "pausing" });
            abortController.abort({
              [CONTROL_ABORT]: true,
              action: pendingAction,
            } satisfies ControlAbortReason);
          }
          break;
        case "resume_agent":
          agentPaused = false;
          resumeAgentPrompt =
            cmd.prompt ?? "Continue from where you left off.";
          break;
      }
    }
  };

  const poll = (): void => {
    applyCommands(runtime.takeCommands());
    if (!abortController || abortController.signal.aborted) return;
    const appendText = runtime.takeAppend();
    if (appendText !== null) {
      pendingAction = { kind: "append", text: appendText };
      runtime.writeState({ status: "pausing" });
      abortController.abort({
        [CONTROL_ABORT]: true,
        action: pendingAction,
      } satisfies ControlAbortReason);
    }
  };

  return {
    currentSignal: () => abortController?.signal,

    beginAgent: (agent, phase, patch) => {
      abortController = new AbortController();
      pendingAction = null;
      runtime.writeState({
        agent,
        phase,
        status: "running",
        sessionId: lastSessionId ?? null,
        ...patch,
      });
      return abortController.signal;
    },

    endAgent: (patch) => {
      abortController = undefined;
      runtime.writeState({
        agent: null,
        status: loopPaused || agentPaused ? "paused" : "running",
        phase: loopPaused ? "paused" : (patch?.phase ?? "idle"),
        ...patch,
      });
    },

    noteSessionId: (sessionId) => {
      lastSessionId = sessionId;
      runtime.writeState({ sessionId });
    },

    sessionId: () => lastSessionId,

    isControlAbort: (error) => isControlAbortReason(error),

    takeAbortAction: () => {
      const action = pendingAction;
      pendingAction = null;
      return action;
    },

    waitWhileLoopPaused: async () => {
      while (loopPaused) {
        runtime.writeState({
          phase: "paused",
          status: "paused",
          agent: null,
        });
        poll();
        if (!loopPaused) break;
        await sleep(500);
      }
    },

    waitForResumeAgent: async () => {
      while (agentPaused) {
        runtime.writeState({ status: "paused", phase: "paused" });
        poll();
        if (!agentPaused) break;
        await sleep(500);
      }
      return resumeAgentPrompt ?? "Continue from where you left off.";
    },

    poll,
    startPolling: (intervalMs = 400) => {
      stopPolling();
      pollTimer = setInterval(() => {
        try {
          poll();
        } catch {
          // Poll failures must not kill the loop.
        }
      }, intervalMs);
    },
    stopPolling,
    close: () => {
      stopPolling();
      abortController = undefined;
    },
  };
};
