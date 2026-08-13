// Planner recipe slice — not a runnable entry. Requires worktree first.
// Copy this pattern into the config directory's root main.ts / main.mts.
//
// Shape: plan → Promise.allSettled(createSandbox + implement) → merge.
// Review is already in standard; with worktree, run it inside each branch
// sandbox after implement (see recipes/worktree/).
//
// Keep the agent and sandbox provider factories already in root main.

import * as sandcastle from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

const copyToWorktree = ["node_modules"];

const plan = await sandcastle.run({
  cwd: repoDir,
  stateDir: workflowDir,
  sandbox: docker(),
  name: "planner",
  maxIterations: 1,
  agent: sandcastle.claudeCode(),
  promptFile: join(workflowDir, "plan-prompt.md"),
  output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
});

const issues = plan.output.issues;
if (issues.length === 0) {
  console.log("No unblocked issues to work on. Exiting.");
} else {
  const settled = await Promise.allSettled(
    issues.map((issue) =>
      sandcastle.run({
        cwd: repoDir,
        stateDir: workflowDir,
        copyToWorktree,
        sandbox: docker(),
        branchStrategy: { type: "branch", branch: issue.branch },
        name: "implementer",
        maxIterations: 100,
        agent: sandcastle.claudeCode(),
        promptFile: join(workflowDir, "implement-prompt.md"),
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      }),
    ),
  );

  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  if (completedBranches.length > 0) {
    await sandcastle.run({
      cwd: repoDir,
      stateDir: workflowDir,
      sandbox: docker(),
      name: "merger",
      maxIterations: 1,
      agent: sandcastle.claudeCode(),
      promptFile: join(workflowDir, "merge-prompt.md"),
      promptArgs: {
        BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
        ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
      },
    });
  }
}
