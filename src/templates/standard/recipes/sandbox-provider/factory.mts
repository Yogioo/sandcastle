// Sandbox-provider recipe slice — not a runnable entry.
// Init already rewrote root main.ts to the chosen provider. To switch
// later, change the import and factory call to match:
//   docker  → import { docker } from "@yogioo/sandcastle/sandboxes/docker"
//   podman  → import { podman } from "@yogioo/sandcastle/sandboxes/podman"
//   no-sandbox → import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox"
//
// createSandbox belongs to recipes/worktree/. For docker({ mounts }) / compose,
// see the Sandcastle README.

import { docker } from "@yogioo/sandcastle/sandboxes/docker";

export const sandbox = docker();
