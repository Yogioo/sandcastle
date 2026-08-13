// Standard workflow — implement-then-review on the current checkout
//
// This template drives a two-phase workflow per issue:
//   Phase 1 (Implement): A sonnet agent picks an open issue, works on it
//                        directly on HEAD, commits the changes, and emits a
//                        structured <outcome> (done / no_change / blocked /
//                        empty).
//   Phase 2 (Review):    A second sonnet agent reviews the commit range from
//                        this implement pass (BASE_SHA..HEAD) and either
//                        approves it or makes corrections on the same tree.
//                        Skipped unless the implementer reports `done` and
//                        produced commits.
//
// Both phases use run({ branchStrategy: { type: "head" } }) — no worktree
// orchestration and no named-branch sandbox handoff.
//
// The outer loop processes one issue per iteration, up to MAX_ITERATIONS
// implement→review cycles. A host-side LIST_TASKS_COMMAND probe gates each
// cycle: no pickable issues stops the run when IDLE_POLL_SECONDS is 0, or
// sleeps and retries when it is > 0 (idle polls do not consume the iteration
// budget). An implementer `empty` report with no commits follows the same
// rule — a race or a list that still contains unpickable issues. A
// missing/invalid <outcome> does not abort the run: one session resume is
// attempted, then the loop falls back to git (commits → review, else skip).
//
// Usage:
//   Run the generated file at the path printed by `sandcastle init`.
//
// Logs: one run directory per process, one loop subdirectory per
// implement→review cycle that actually starts — see AGENTS.md → Logs for
// the layout and how to find a cycle by task id.

import {
  run,
  claudeCode,
  Output,
  StructuredOutputError,
} from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  iterationPadWidth,
  localTimestamp,
  padStart,
  pointerLine,
  teeConsole,
  uniqueDirName,
} from "./logs.js";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

// The implementer emits its result as JSON inside <outcome> tags; Output.object
// extracts and validates it against this schema. We use Zod here, but any
// Standard Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const outcomeSchema = z.object({
  status: z.enum(["done", "no_change", "blocked", "empty"]),
  taskId: z.string().optional(),
});

type Outcome = z.infer<typeof outcomeSchema>;

const outcomeOutput = () =>
  Output.object({ tag: "outcome", schema: outcomeSchema });

const outcomeRetryPrompt = (error: StructuredOutputError): string =>
  `Your previous response did not produce valid <outcome> JSON (${error.message}). Emit only a corrected <outcome> block. Do not change files or run commands.`;

const fallbackOutcome = (
  commits: { sha: string }[],
): { status: Outcome["status"]; commits: { sha: string }[] } => ({
  status: commits.length > 0 ? "done" : "blocked",
  commits,
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
// Idle polls (empty backlog) do not count toward this budget.
const MAX_ITERATIONS = 10;

// Seconds to wait when no issues are pickable.
// > 0 = idle-and-poll on the host until work appears; does not start an
// agent while idle.
// 0 = drain-and-stop (exit when the list is empty).
const IDLE_POLL_SECONDS = 30;

// Same list command the implementer prompt interpolates. Idle polling runs
// it on the host so an empty backlog does not start an agent.
const LIST_TASKS_COMMAND = "{{LIST_TASKS_COMMAND}}";

// Give up after this many consecutive invalid <outcome> payloads that could
// not be repaired by a session resume. Prevents a broken prompt from burning
// the full iteration budget.
const MAX_OUTCOME_FAILURES = 3;

// Add a sandbox.onSandboxReady install command if you need a
// package-manager install after the sandbox is ready — there is no default.

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseReadyCount = (stdout: string): number => {
  const trimmed = stdout.trim();
  if (!trimmed) return 0;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["issues", "tasks", "items"]) {
        if (Array.isArray(record[key])) return record[key].length;
      }
      return 1;
    }
    return 0;
  } catch {
    return trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0)
      .length;
  }
};

type ReadyProbe = { ok: true; count: number } | { ok: false };

const probeReadyTasks = (): ReadyProbe => {
  try {
    const stdout = execSync(LIST_TASKS_COMMAND, {
      cwd: repoDir,
      encoding: "utf-8",
      // execSync already runs the command in the platform default shell.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, count: parseReadyCount(stdout) };
  } catch (error) {
    console.error(`Failed to list pickable issues: ${error}`);
    return { ok: false };
  }
};

// ---------------------------------------------------------------------------
// Logging layout
// ---------------------------------------------------------------------------
// One process = one run directory under logs/; one implement→review cycle
// that actually starts = one loop subdirectory. Nothing is deleted or
// rotated — pointer lines in main.log map task ids to loop directories.

const logsRoot = join(workflowDir, "logs");
const runDir = join(
  logsRoot,
  uniqueDirName(logsRoot, `run-${localTimestamp()}`),
);
mkdirSync(runDir, { recursive: true });
const mainLogPath = join(runDir, "main.log");
const loopPadWidth = iterationPadWidth(MAX_ITERATIONS);

// Tee host console output into main.log (terminal output is preserved).
// Patched before the first run() so the `tail -f` startup hints land in the
// file as well.
teeConsole(mainLogPath);

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let consecutiveOutcomeFailures = 0;
let iteration = 0;

while (iteration < MAX_ITERATIONS) {
  const probed = probeReadyTasks();
  if (!probed.ok && IDLE_POLL_SECONDS > 0) {
    console.log(
      `Could not list pickable issues. Polling again in ${IDLE_POLL_SECONDS}s...`,
    );
    await sleep(IDLE_POLL_SECONDS * 1000);
    continue;
  }
  if (probed.ok && probed.count <= 0) {
    if (IDLE_POLL_SECONDS <= 0) {
      console.log("No pickable issues. Stopping.");
      break;
    }
    console.log(
      `No pickable issues. Polling again in ${IDLE_POLL_SECONDS}s...`,
    );
    await sleep(IDLE_POLL_SECONDS * 1000);
    continue;
  }

  iteration += 1;
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // One loop directory per cycle that actually starts — idle polls never
  // reach this point. Both logs live in it; an <outcome> retry appends to
  // the same implement.log instead of creating a new directory.
  const loopDirName = uniqueDirName(
    runDir,
    `${padStart(iteration, loopPadWidth)}-${localTimestamp()}`,
  );
  const loopDir = join(runDir, loopDirName);
  mkdirSync(loopDir, { recursive: true });

  // Capture HEAD before implement so review diffs only this pass's commits.
  const baseSha = execSync("git rev-parse HEAD", {
    cwd: repoDir,
    encoding: "utf-8",
  }).trim();

  const implementOpts = {
    name: "implementer" as const,
    cwd: repoDir,
    stateDir: workflowDir,
    maxIterations: 1 as const,
    agent: claudeCode(),
    sandbox: docker(),
    promptFile: join(workflowDir, "implement-prompt.md"),
    branchStrategy: { type: "head" as const },
    output: outcomeOutput(),
    logging: { type: "file" as const, path: join(loopDir, "implement.log") },
  };

  // -----------------------------------------------------------------------
  // Phase 1: Implement
  //
  // Structured <outcome> tells the outer loop whether to review, continue,
  // or stop. COMPLETE only ends this run(); commit count is a fallback when
  // the tag is missing or invalid.
  // -----------------------------------------------------------------------
  let status: Outcome["status"];
  let taskId: string | undefined;
  let commits: { sha: string }[];

  try {
    const implement = await run(implementOpts);
    status = implement.output.status;
    taskId = implement.output.taskId;
    commits = implement.commits;
    consecutiveOutcomeFailures = 0;
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error;

    if (error.sessionId) {
      try {
        const retried = await run({
          ...implementOpts,
          prompt: outcomeRetryPrompt(error),
          promptFile: undefined,
          resumeSession: error.sessionId,
        });
        status = retried.output.status;
        taskId = retried.output.taskId;
        commits = retried.commits;
        consecutiveOutcomeFailures = 0;
      } catch (retryError) {
        if (!(retryError instanceof StructuredOutputError)) throw retryError;
        console.error(
          `Implementer <outcome> still invalid after resume: ${retryError.message}`,
        );
        ({ status, commits } = fallbackOutcome(retryError.commits));
        if (status === "blocked") consecutiveOutcomeFailures++;
        else consecutiveOutcomeFailures = 0;
      }
    } else {
      console.error(`Implementer <outcome> invalid: ${error.message}`);
      ({ status, commits } = fallbackOutcome(error.commits));
      if (status === "blocked") consecutiveOutcomeFailures++;
      else consecutiveOutcomeFailures = 0;
    }
  }

  if (consecutiveOutcomeFailures >= MAX_OUTCOME_FAILURES) {
    console.log(
      `${MAX_OUTCOME_FAILURES} consecutive invalid <outcome> payloads. Stopping.`,
    );
    break;
  }

  // Empty with no commits is a drained backlog or a race (the ticket was
  // claimed between the host probe and this agent). Drain-and-stop exits;
  // idle-and-poll sleeps without burning another iteration.
  if (status === "empty" && commits.length === 0) {
    if (IDLE_POLL_SECONDS <= 0) {
      console.log("No pickable issues. Stopping.");
      break;
    }
    console.log(
      `No pickable issues. Polling again in ${IDLE_POLL_SECONDS}s...`,
    );
    await sleep(IDLE_POLL_SECONDS * 1000);
    continue;
  }

  if (status === "empty" && commits.length > 0) {
    console.log("Implementer said empty but made commits; treating as done.");
    status = "done";
  }

  console.log(
    `\nImplementation ${status}` +
      (taskId ? ` (${taskId})` : "") +
      ` — ${commits.length} commit(s).`,
  );

  // Pointer line: map this cycle's task id to its loop directory. Teed into
  // main.log by the console patch above.
  console.log(
    pointerLine(iteration, loopPadWidth, status, taskId, loopDirName),
  );

  // -----------------------------------------------------------------------
  // Phase 2: Review
  //
  // Only review when this pass actually landed commits. Review failures
  // are logged and the outer loop continues.
  // -----------------------------------------------------------------------
  if (status === "done" && commits.length > 0) {
    console.log(`Reviewing commit range: ${baseSha}..HEAD`);

    try {
      await run({
        name: "reviewer",
        cwd: repoDir,
        stateDir: workflowDir,
        maxIterations: 1,
        agent: claudeCode(),
        sandbox: docker(),
        promptFile: join(workflowDir, "review-prompt.md"),
        promptArgs: {
          BASE_SHA: baseSha,
        },
        branchStrategy: { type: "head" },
        logging: { type: "file" as const, path: join(loopDir, "reviewer.log") },
      });
      console.log("\nReview complete.");
    } catch (error) {
      console.error(`Review failed: ${error}`);
    }
  } else {
    console.log("Skipping review.");
  }
}

console.log("\nAll done.");
