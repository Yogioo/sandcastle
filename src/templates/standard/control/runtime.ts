// File-based control plane for the implement workflow.
//
// Layout under the config directory:
//
//   .sandcastle/runtime/
//     state.json
//     events.jsonl
//     inbox/append.txt
//     commands.jsonl
//
// The host loop writes state + events; humans/UI write inbox + commands.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Phase = "idle" | "implement" | "review" | "paused";
export type AgentRole = "implementer" | "reviewer" | null;
export type RunStatus = "running" | "pausing" | "paused" | "resuming";

export type RuntimeState = {
  runId: string;
  iteration: number;
  phase: Phase;
  agent: AgentRole;
  status: RunStatus;
  sessionId: string | null;
  taskId: string | null;
  loopDir: string | null;
  mainLog: string | null;
  implementLog: string | null;
  reviewerLog: string | null;
  updatedAt: string;
};

export type ControlCommand =
  | { type: "pause_agent" }
  | { type: "resume_agent"; prompt?: string }
  | { type: "pause_loop" }
  | { type: "resume_loop" };

export type RuntimePaths = {
  root: string;
  state: string;
  events: string;
  inboxDir: string;
  appendInbox: string;
  commands: string;
};

const nowIso = (): string => new Date().toISOString();

const defaultState = (runId: string, mainLog: string | null): RuntimeState => ({
  runId,
  iteration: 0,
  phase: "idle",
  agent: null,
  status: "running",
  sessionId: null,
  taskId: null,
  loopDir: null,
  mainLog,
  implementLog: null,
  reviewerLog: null,
  updatedAt: nowIso(),
});

/** Atomic-ish JSON write (temp + rename) so readers never see a partial object. */
const writeJson = (path: string, value: unknown): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
};

export type Runtime = {
  readonly paths: RuntimePaths;
  readonly vizDir: string;
  readState: () => RuntimeState;
  writeState: (patch: Partial<RuntimeState>) => RuntimeState;
  appendEvent: (event: unknown) => void;
  /** Read+clear inbox/append.txt. Returns null when empty/missing. */
  takeAppend: () => string | null;
  /** Drain new command lines since last poll (append-only jsonl). */
  takeCommands: () => ControlCommand[];
  enqueueCommand: (command: ControlCommand) => void;
  writeAppend: (text: string) => void;
};

export const createRuntime = (
  workflowDir: string,
  runId: string,
  opts?: { mainLog?: string | null; vizDir?: string },
): Runtime => {
  const root = join(workflowDir, "runtime");
  const inboxDir = join(root, "inbox");
  const paths: RuntimePaths = {
    root,
    state: join(root, "state.json"),
    events: join(root, "events.jsonl"),
    inboxDir,
    appendInbox: join(inboxDir, "append.txt"),
    commands: join(root, "commands.jsonl"),
  };
  mkdirSync(inboxDir, { recursive: true });

  let state = defaultState(runId, opts?.mainLog ?? null);
  writeJson(paths.state, state);
  if (!existsSync(paths.events)) writeFileSync(paths.events, "", "utf-8");
  if (!existsSync(paths.commands)) writeFileSync(paths.commands, "", "utf-8");

  let commandsOffset = 0;

  const readState = (): RuntimeState => {
    try {
      const raw = readFileSync(paths.state, "utf-8");
      state = JSON.parse(raw) as RuntimeState;
      return state;
    } catch {
      return state;
    }
  };

  const writeState = (patch: Partial<RuntimeState>): RuntimeState => {
    state = { ...readState(), ...patch, updatedAt: nowIso() };
    writeJson(paths.state, state);
    return state;
  };

  const appendEvent = (event: unknown): void => {
    appendFileSync(paths.events, `${JSON.stringify(event)}\n`, "utf-8");
  };

  const takeAppend = (): string | null => {
    if (!existsSync(paths.appendInbox)) return null;
    const text = readFileSync(paths.appendInbox, "utf-8");
    try {
      unlinkSync(paths.appendInbox);
    } catch {
      writeFileSync(paths.appendInbox, "", "utf-8");
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? text : null;
  };

  const parseCommand = (line: string): ControlCommand | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; prompt?: string };
      switch (parsed.type) {
        case "pause_agent":
        case "pause_loop":
        case "resume_loop":
          return { type: parsed.type };
        case "resume_agent":
          return {
            type: "resume_agent",
            prompt:
              typeof parsed.prompt === "string" ? parsed.prompt : undefined,
          };
        default:
          return null;
      }
    } catch {
      return null;
    }
  };

  const takeCommands = (): ControlCommand[] => {
    if (!existsSync(paths.commands)) return [];
    const raw = readFileSync(paths.commands, "utf-8");
    if (commandsOffset > raw.length) commandsOffset = 0;
    const chunk = raw.slice(commandsOffset);
    commandsOffset = raw.length;
    const out: ControlCommand[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      const cmd = parseCommand(line);
      if (cmd) out.push(cmd);
    }
    return out;
  };

  const enqueueCommand = (command: ControlCommand): void => {
    appendFileSync(paths.commands, `${JSON.stringify(command)}\n`, "utf-8");
  };

  const writeAppend = (text: string): void => {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(paths.appendInbox, text, "utf-8");
  };

  return {
    paths,
    vizDir: opts?.vizDir ?? join(workflowDir, "viz"),
    readState,
    writeState,
    appendEvent,
    takeAppend,
    takeCommands,
    enqueueCommand,
    writeAppend,
  };
};
