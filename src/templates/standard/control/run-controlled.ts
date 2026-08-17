// Shared helper: run one agent phase with control-plane abort → resume.
// Template-local — does not import Sandcastle internals.

import type { AgentStreamEvent } from "@yogioo/sandcastle";
import type { LoopController } from "./controller.js";
import type { Runtime, RuntimeState } from "./runtime.js";

export type ControlledRunOpts = {
  signal: AbortSignal;
  resumeSession?: string;
  prompt?: string;
  promptFile?: string;
  onAgentStreamEvent: (event: AgentStreamEvent) => void;
};

/**
 * Runs `execute` under the control plane. On append / pause_agent abort,
 * resumes via resumeSession when a session id is known. On pause_loop abort,
 * returns `{ abortedLoop: true }` without resuming the agent.
 */
export const runControlled = async <T>(params: {
  controller: LoopController;
  runtime: Runtime;
  agent: NonNullable<RuntimeState["agent"]>;
  phase: "implement" | "review";
  statePatch?: Partial<RuntimeState>;
  /** Initial promptFile (cleared on resume/append). */
  promptFile?: string;
  execute: (opts: ControlledRunOpts) => Promise<T>;
}): Promise<{ ok: true; result: T } | { ok: false; abortedLoop: true }> => {
  const { controller, runtime, agent, phase, statePatch, promptFile, execute } =
    params;

  let resumeSession: string | undefined;
  let prompt: string | undefined;
  let usePromptFile = promptFile;

  for (;;) {
    const signal = controller.beginAgent(agent, phase, statePatch);
    const onAgentStreamEvent = (event: AgentStreamEvent) => {
      runtime.appendEvent({
        ...event,
        timestamp:
          event.timestamp instanceof Date
            ? event.timestamp.toISOString()
            : event.timestamp,
      });
      if (event.type === "sessionId") {
        controller.noteSessionId(event.sessionId);
      }
    };

    controller.startPolling();
    try {
      const result = await execute({
        signal,
        resumeSession,
        prompt,
        promptFile: usePromptFile,
        onAgentStreamEvent,
      });
      controller.endAgent({ phase: "idle" });
      return { ok: true, result };
    } catch (error) {
      if (!controller.isControlAbort(error)) {
        controller.endAgent({ phase: "idle" });
        throw error;
      }

      const action = controller.takeAbortAction();
      const sessionId = controller.sessionId();
      controller.endAgent({
        phase: action?.kind === "pause_loop" ? "paused" : "paused",
        status: "paused",
        sessionId: sessionId ?? null,
      });

      if (!action || action.kind === "pause_loop") {
        return { ok: false, abortedLoop: true };
      }

      if (!sessionId) {
        console.error(
          `Control abort (${action.kind}) but no sessionId was captured — cannot resumeSession.`,
        );
        return { ok: false, abortedLoop: true };
      }

      if (action.kind === "append") {
        console.log("Append: aborting agent and resuming session…");
        resumeSession = sessionId;
        prompt = action.text;
        usePromptFile = undefined;
        runtime.writeState({ status: "resuming" });
        continue;
      }

      // pause_agent
      console.log("Agent paused. Waiting for resume_agent…");
      const resumePrompt = await controller.waitForResumeAgent();
      resumeSession = sessionId;
      prompt = resumePrompt;
      usePromptFile = undefined;
      runtime.writeState({ status: "resuming" });
      continue;
    } finally {
      controller.stopPolling();
    }
  }
};
