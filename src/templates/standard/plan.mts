// Planning workflow — grill → spec → tickets on discussion tasks
//
// This template drives the planning workflow on one discussion task at a
// time. The implement workflow (main.mts) never lists discussion tasks, and
// this entry never lists ready tasks. Started by `sandcastle plan`, never
// by `sandcastle`.
//
// One loop iteration runs exactly one planning phase (grill, spec, or
// tickets) as its own agent session — phase isolation lives here in the
// orchestrator, never in "call two skills in one session". After a phase
// lands its tracker change (label or comment), the next iteration probes
// the task again and immediately runs the next phase: aligned → spec →
// tickets with no idle sleep between them.
//
// A host-side probe gates each cycle: no discussion tasks, or a task whose
// latest comment is the agent's (waiting on a human), stops the run when
// IDLE_POLL_SECONDS is 0, or sleeps and retries when it is > 0. Idle polls
// never start an agent and never consume the iteration budget.
//
// Usage:
//   Run the generated file at the path printed by `sandcastle init`.

import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probePlanningPhase } from "./probe.js";
import { padStart } from "./logs.js";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of planning phases to run before stopping. One phase per
// iteration. Raise this to process more discussion tasks per run. Idle polls
// (waiting on a human) do not count toward this budget.
const MAX_ITERATIONS = 10;

// Seconds to wait when no discussion task is actionable.
// > 0 = idle-and-poll on the host until a phase is ready; does not start an
// agent while idle.
// 0 = drain-and-stop (exit when there is nothing to run).
const IDLE_POLL_SECONDS = 30;

// Kill the agent when it produces no output for this many seconds (silent
// hang). Each output event resets the timer. Omitted or 0 = disabled.
const AGENT_IDLE_TIMEOUT_SECONDS = 600;

// After an idle timeout, auto-restart with previous output + a timeout note.
// 2 = up to 3 attempts total. 0 = fail on first idle timeout.
const AGENT_RESTART_LIMIT = 2;

// Discussion tasks only — never ready tasks. Excludes `planned` parents
// whose child tasks were already created.
const LIST_PLANNING_TASKS_COMMAND = "{{LIST_PLANNING_TASKS_COMMAND}}";

const grillPromptFile = join(workflowDir, "grill-prompt.md");
const specPromptFile = join(workflowDir, "spec-prompt.md");
const ticketsPromptFile = join(workflowDir, "tickets-prompt.md");

const logsDir = join(workflowDir, "logs");
mkdirSync(logsDir, { recursive: true });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Host probe
// ---------------------------------------------------------------------------

interface DiscussionTask {
  number: string | number;
  title: string;
  body: string;
  labels: string[];
  comments: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * Parse the tracker list stdout into discussion tasks. GitHub's jq output
 * shape is {number, title, body, labels, comments}; beads differs, so the
 * probe is tolerant: any array of records with an id/title works.
 */
const parseDiscussionTasks = (stdout: string): DiscussionTask[] => {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).map((record) => {
      const number = record["number"] ?? record["id"];
      return {
        number:
          typeof number === "string" || typeof number === "number"
            ? number
            : "",
        title: String(record["title"] ?? ""),
        body: String(record["body"] ?? ""),
        labels: asStringArray(record["labels"]),
        comments: asStringArray(record["comments"]),
      };
    });
  } catch {
    return [];
  }
};

type ProbeResult = { ok: true; task?: DiscussionTask } | { ok: false };

const probeDiscussionTasks = (): ProbeResult => {
  try {
    const stdout = execSync(LIST_PLANNING_TASKS_COMMAND, {
      cwd: repoDir,
      encoding: "utf-8",
      // No shell option — execSync already runs in the platform default shell.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, task: parseDiscussionTasks(stdout)[0] };
  } catch (error) {
    console.error(`Failed to list discussion tasks: ${error}`);
    return { ok: false };
  }
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let iteration = 0;

while (iteration < MAX_ITERATIONS) {
  const probed = probeDiscussionTasks();
  if (!probed.ok) {
    if (IDLE_POLL_SECONDS <= 0) {
      console.log("Could not list discussion tasks. Stopping.");
      break;
    }
    console.log(
      `Could not list discussion tasks. Polling again in ${IDLE_POLL_SECONDS}s...`,
    );
    await sleep(IDLE_POLL_SECONDS * 1000);
    continue;
  }
  if (probed.task === undefined) {
    if (IDLE_POLL_SECONDS <= 0) {
      console.log("No discussion tasks. Stopping.");
      break;
    }
    console.log(
      `No discussion tasks. Polling again in ${IDLE_POLL_SECONDS}s...`,
    );
    await sleep(IDLE_POLL_SECONDS * 1000);
    continue;
  }

  const phase = probePlanningPhase(probed.task);

  // Waiting on a human — the latest comment is the agent's and the task is
  // not aligned. Idle-poll on the host: no sandbox, no iteration spent.
  if (phase === "wait") {
    if (IDLE_POLL_SECONDS <= 0) {
      console.log("Waiting on a human reply. Stopping.");
      break;
    }
    console.log(
      `Waiting on a human reply. Polling again in ${IDLE_POLL_SECONDS}s...`,
    );
    await sleep(IDLE_POLL_SECONDS * 1000);
    continue;
  }

  iteration += 1;
  console.log(
    `\n=== Iteration ${iteration}/${MAX_ITERATIONS} — ${phase} ===\n`,
  );

  // Phase isolation: exactly one run() per iteration. The phase selects the
  // prompt file; a phase never invokes the next phase's skill. After this
  // session lands its tracker change, the next iteration probes again and
  // moves straight to the next phase — no idle sleep between phases.
  const promptFile =
    phase === "grill"
      ? grillPromptFile
      : phase === "spec"
        ? specPromptFile
        : ticketsPromptFile;

  await run({
    name: phase,
    cwd: repoDir,
    stateDir: workflowDir,
    maxIterations: 1,
    agent: claudeCode(),
    sandbox: docker(),
    promptFile,
    branchStrategy: { type: "head" },
    idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
    agentRestartLimit: AGENT_RESTART_LIMIT,
    logging: {
      type: "file",
      path: join(logsDir, `planning-${padStart(iteration, 2)}-${phase}.log`),
    },
  });
}

console.log("\nAll done.");
