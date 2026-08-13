import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoDir = process.cwd();
const workflowDir = fileURLToPath(new URL(".", import.meta.url));

// Blank template: customize this to build your own orchestration.
// Run this with the path printed by `sandcastle init`.
// The generated entry file is main.mts (or main.ts for ESM projects).

await run({
  cwd: repoDir,
  stateDir: workflowDir,
  agent: claudeCode(),
  sandbox: docker(),
  promptFile: join(workflowDir, "prompt.md"),
});
