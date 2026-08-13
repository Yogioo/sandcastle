import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

// Simple loop (head): an agent that picks open issues one by one and closes
// them, writing directly to the current working tree. No git worktree.
// Run this with the path printed by `sandcastle init`.

await run({
  cwd: repoDir,
  stateDir: workflowDir,
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — runs the agent inside an isolated container.
  sandbox: docker(),

  // The agent provider. Pass a model string to claudeCode() — sonnet balances
  // capability and speed for most tasks. Switch to claude-opus-4-8 for harder
  // problems, or claude-haiku-4-5-20251001 for speed.
  agent: claudeCode("claude-sonnet-4-6"),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: join(workflowDir, "prompt.md"),

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 3,

  // Branch strategy — head mode writes directly to the current working tree.
  // Prefer this when you want a single checkout (e.g. Unity / local IDE) and
  // do not want a temporary worktree.
  branchStrategy: { type: "head" },

  // Add a sandbox.onSandboxReady install command if you need a
  // package-manager install after the sandbox is ready — there is no default.
});
