// Sequential Reviewer (head) — implement-then-review on the current checkout
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
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration. It stops when the implementer reports `empty` with no commits.
// A missing/invalid <outcome> does not abort the run: one session resume is
// attempted, then the loop falls back to git (commits → review, else skip).
//
// Usage:
//   Run the generated file at the path printed by `sandcastle init`.

import {
  run,
  claudeCode,
  Output,
  StructuredOutputError,
} from "@yogioo/sandcastle";
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
const MAX_ITERATIONS = 10;

// Give up after this many consecutive invalid <outcome> payloads that could
// not be repaired by a session resume. Prevents a broken prompt from burning
// the full iteration budget.
const MAX_OUTCOME_FAILURES = 3;

// Add a sandbox.onSandboxReady install command if you need a
// package-manager install after the sandbox is ready — there is no default.

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let consecutiveOutcomeFailures = 0;

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

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
    `\nImplementation ${status}` +
      (taskId ? ` (${taskId})` : "") +
      ` — ${commits.length} commit(s).`,
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
