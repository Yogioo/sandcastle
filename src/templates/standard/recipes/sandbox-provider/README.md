# Sandbox provider

**Not a workflow feature.** This recooks the **init** **sandbox provider** choice (docker ↔ podman ↔ no-sandbox). It does not change orchestration (implement/review/planner/worktree).

Only apply this when the user explicitly asks to switch **sandbox provider**.

`createSandbox` belongs to `recipes/worktree/`, not here.

## File set init already rewrites

Init writes these from the chosen provider. To switch after init, edit the same set by hand:

| File                               | docker                                                            | podman                                                         | no-sandbox                                                            |
| ---------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Root `main.ts` / `main.mts` import | `import { docker } from "@yogioo/sandcastle/sandboxes/docker"`    | `import { podman } from "@yogioo/sandcastle/sandboxes/podman"` | `import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox"` |
| Factory call                       | `docker()`                                                        | `podman()`                                                     | `noSandbox()`                                                         |
| Container file                     | `Dockerfile`                                                      | `Containerfile`                                                | neither — delete the container file                                   |
| `CODING_STANDARDS.md` in prompts   | `@.sandcastle/CODING_STANDARDS.md` (mounted into the **sandbox**) | same                                                           | host path: `@<config-dir>/CODING_STANDARDS.md`                        |

When the workflow has `CODING_STANDARDS.md` and the provider uses a container file, the factory call is `docker({ mounts: [{ hostPath: join(workflowDir, "CODING_STANDARDS.md"), sandboxPath: ".sandcastle/CODING_STANDARDS.md", readonly: true }] })` (or `podman({ mounts: ... })`).

For `docker({ mounts })`, compose, and other Docker API options, see the Sandcastle README. Do not copy that API into this recipe.

Do not change the **agent** factory or **issue tracker** commands while switching provider.
