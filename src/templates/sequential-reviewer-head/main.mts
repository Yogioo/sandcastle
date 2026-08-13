// Sequential Reviewer (head) — implement-then-review on the current checkout
//
// This template drives a two-phase workflow per issue:
//   Phase 1 (Implement): A sonnet agent picks an open issue, works on it
//                        directly on HEAD, commits the changes, and signals
//                        completion.
//   Phase 2 (Review):    A second sonnet agent reviews the commit range from
//                        this implement pass (BASE_SHA..HEAD) and either
//                        approves it or makes corrections on the same tree.
//
// Both phases use run({ branchStrategy: { type: "head" } }) — no worktree
// orchestration and no named-branch sandbox handoff.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration and stopping early once the backlog is exhausted (an implement
// phase that produces no commits).
//
// Usage:
//   Run the generated file at the path printed by `sandcastle init`.

import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Capture HEAD before implement so review diffs only this pass's commits.
  const baseSha = execSync("git rev-parse HEAD", {
    cwd: repoDir,
    encoding: "utf-8",
  }).trim();

  // -----------------------------------------------------------------------
  // Phase 1: Implement
  //
  // A sonnet agent picks the next open issue, writes the
  // implementation (using RGR: Red → Green → Repeat → Refactor), and
  // commits the result directly on HEAD.
  //
  // The agent signals completion via <promise>COMPLETE</promise> when done.
  // -----------------------------------------------------------------------
  // One iteration so each outer pass implements a single issue, then hands
  // it to the reviewer. A higher value lets the agent drain the whole
  // backlog in a single pass, which defeats the per-issue review.
  const implement = await run({
    name: "implementer",
    cwd: repoDir,
    stateDir: workflowDir,
    maxIterations: 1,
    agent: claudeCode("claude-sonnet-4-6"),
    sandbox: docker(),
    promptFile: join(workflowDir, "implement-prompt.md"),
    branchStrategy: { type: "head" },
    hooks,
  });

  if (!implement.commits.length) {
    // No commits means the backlog is empty or every remaining issue is
    // blocked — there is nothing left to implement or review, so stop.
    console.log("Implementation agent made no commits. Stopping.");
    break;
  }

  console.log(
    `\nImplementation complete (${implement.commits.length} commit(s)).`,
  );
  console.log(`Reviewing commit range: ${baseSha}..HEAD`);

  // -----------------------------------------------------------------------
  // Phase 2: Review
  //
  // A second sonnet agent reviews the commit range produced by Phase 1
  // (BASE_SHA..HEAD on the same tree) and either approves or makes
  // corrections directly on HEAD.
  // -----------------------------------------------------------------------
  await run({
    name: "reviewer",
    cwd: repoDir,
    stateDir: workflowDir,
    maxIterations: 1,
    agent: claudeCode("claude-sonnet-4-6"),
    sandbox: docker(),
    promptFile: join(workflowDir, "review-prompt.md"),
    promptArgs: {
      BASE_SHA: baseSha,
    },
    branchStrategy: { type: "head" },
    hooks,
  });

  console.log("\nReview complete.");
}

console.log("\nAll done.");
