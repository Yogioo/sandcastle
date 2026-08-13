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
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration. It stops when the implementer reports `empty` with no commits.
// A missing/invalid <outcome> does not abort the run: one session resume is
// attempted, then the loop falls back to git (commits → review, else skip).
//
// Usage:
//   Run the generated file at the path printed by `sandcastle init`.

import * as sandcastle from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
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
const MAX_ITERATIONS = 10;

// Give up after this many consecutive invalid <outcome> payloads that could
// not be repaired by a session resume. Prevents a broken prompt from burning
// the full iteration budget.
const MAX_OUTCOME_FAILURES = 3;

// Copy node_modules from the host into the worktree when it exists.
// Missing paths are skipped, so this is a no-op for non-Node projects.
// Add a sandbox.onSandboxReady install command if you need a
// package-manager install after the sandbox is ready — there is no default.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let consecutiveOutcomeFailures = 0;

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
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

    // Stop only when the agent says the backlog is empty *and* git agrees.
    // An `empty` report with commits is treated as done so work is not dropped.
    if (status === "empty" && commits.length === 0) {
      console.log("No pickable issues. Stopping.");
      break;
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
