// Sequential Reviewer — implement-then-review loop
//
// This template drives a two-phase workflow per issue:
//   Phase 1 (Implement): A sonnet agent picks an open issue, works on it
//                        on a dedicated branch, commits the changes, and
//                        emits a structured <outcome> (done / no_change /
//                        blocked / empty).
//   Phase 2 (Review):    A second sonnet agent reviews the branch diff and
//                        either approves it or makes corrections directly on
//                        the branch. Skipped unless the implementer reports
//                        `done` and produced commits.
//
// Both phases share a single sandbox created via createSandbox(), so the
// implementer and reviewer work on the same explicit branch.
//
// The outer loop processes one issue per iteration, up to MAX_ITERATIONS
// implement→review cycles. A host-side LIST_TASKS_COMMAND probe gates each
// cycle: no pickable issues stops the run when IDLE_POLL_SECONDS is 0, or
// sleeps and retries when it is > 0 (idle polls do not consume the iteration
// budget, and no sandbox is created until work exists). An implementer
// `empty` report with no commits follows the same rule — a race or a list
// that still contains unpickable issues. A missing/invalid <outcome> does
// not abort the run: one session resume is attempted, then the loop falls
// back to git (commits → review, else skip).
//
// Usage:
//   Run the generated file at the path printed by `sandcastle init`.

import * as sandcastle from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

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
  sandcastle.Output.object({ tag: "outcome", schema: outcomeSchema });

const outcomeRetryPrompt = (error: sandcastle.StructuredOutputError): string =>
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
// agent or create a sandbox while idle.
// 0 = drain-and-stop (exit when the list is empty).
const IDLE_POLL_SECONDS = 30;

// Same list command the implementer prompt interpolates. Idle polling runs
// it on the host so an empty backlog does not start an agent or sandbox.
const LIST_TASKS_COMMAND = "{{LIST_TASKS_COMMAND}}";

// Give up after this many consecutive invalid <outcome> payloads that could
// not be repaired by a session resume. Prevents a broken prompt from burning
// the full iteration budget.
const MAX_OUTCOME_FAILURES = 3;

// Copy node_modules from the host into the worktree when it exists.
// Missing paths are skipped, so this is a no-op for non-Node projects.
// Add a sandbox.onSandboxReady install command if you need a
// package-manager install after the sandbox is ready — there is no default.
const copyToWorktree = ["node_modules"];

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
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, count: parseReadyCount(stdout) };
  } catch (error) {
    console.error(`Failed to list pickable issues: ${error}`);
    return { ok: false };
  }
};

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

  // Generate a unique branch name for this iteration.
  const branch = `sandcastle/sequential-reviewer/${Date.now()}`;

  // Create a single sandbox that both the implementer and reviewer share.
  // This gives both agents a real, named branch that persists across phases.
  const sandbox = await sandcastle.createSandbox({
    branch,
    cwd: repoDir,
    stateDir: workflowDir,
    sandbox: docker(),
    copyToWorktree,
  });

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Implement
    //
    // Structured <outcome> tells the outer loop whether to review, continue,
    // or stop. COMPLETE only ends this run(); commit count is a fallback when
    // the tag is missing or invalid.
    // -----------------------------------------------------------------------
    const implementOpts = {
      name: "implementer" as const,
      maxIterations: 1 as const,
      agent: sandcastle.claudeCode(),
      promptFile: join(workflowDir, "implement-prompt.md"),
      output: outcomeOutput(),
    };

    let status: Outcome["status"];
    let taskId: string | undefined;
    let commits: { sha: string }[];

    try {
      const implement = await sandbox.run(implementOpts);
      status = implement.output.status;
      taskId = implement.output.taskId;
      commits = implement.commits;
      consecutiveOutcomeFailures = 0;
    } catch (error) {
      if (!(error instanceof sandcastle.StructuredOutputError)) throw error;

      if (error.sessionId) {
        try {
          const retried = await sandbox.run({
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
          if (!(retryError instanceof sandcastle.StructuredOutputError)) {
            throw retryError;
          }
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
      `\nImplementation ${status} on branch: ${branch}` +
        (taskId ? ` (${taskId})` : ""),
    );
    console.log(`Commits: ${commits.length}`);

    // -----------------------------------------------------------------------
    // Phase 2: Review
    //
    // Only review when this pass actually landed commits. Review failures
    // are logged and the outer loop continues.
    // -----------------------------------------------------------------------
    if (status === "done" && commits.length > 0) {
      try {
        await sandbox.run({
          name: "reviewer",
          maxIterations: 1,
          agent: sandcastle.claudeCode(),
          promptFile: join(workflowDir, "review-prompt.md"),
          promptArgs: {
            BRANCH: branch,
          },
        });
        console.log("\nReview complete.");
      } catch (error) {
        console.error(`Review failed: ${error}`);
      }
    } else {
      console.log("Skipping review.");
    }
  } finally {
    await sandbox.close();
  }
}

console.log("\nAll done.");
