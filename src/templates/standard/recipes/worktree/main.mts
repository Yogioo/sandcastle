// Worktree recipe slice — not a runnable entry. Copy this pattern into
// the config directory's root main.ts / main.mts.
//
// Differences from standard (head):
//   - copyToWorktree for host node_modules
//   - createSandbox({ branch }) so implement and review share one sandbox
//   - review promptArgs use BRANCH, not BASE_SHA
//
// Keep the agent and sandbox provider factories already in root main.

import * as sandcastle from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

const copyToWorktree = ["node_modules"];

const branch = `sandcastle/worktree/${Date.now()}`;

const sandbox = await sandcastle.createSandbox({
  branch,
  cwd: repoDir,
  stateDir: workflowDir,
  sandbox: docker(),
  copyToWorktree,
});

try {
  const implement = await sandbox.run({
    name: "implementer",
    maxIterations: 1,
    agent: sandcastle.claudeCode(),
    promptFile: join(workflowDir, "implement-prompt.md"),
  });

  if (implement.commits.length > 0) {
    await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: sandcastle.claudeCode(),
      promptFile: join(workflowDir, "review-prompt.md"),
      promptArgs: {
        BRANCH: branch,
      },
    });
  }
} finally {
  await sandbox.close();
}
