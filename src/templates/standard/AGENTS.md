# Workflow guide

This **config directory** was copied from the **standard** **workflow template**: a sequential implement→review loop on **head**. `@.sandcastle/AGENTS.md` is this file. Root `main.ts` / `main.mts` is the only runnable entry — do not add a feature-flag matrix there.

After **init**, edit files here. **Agent** (+ optional **model**), **sandbox provider**, and **issue tracker** are already written into root `main.ts`. When adapting orchestration, do not change those factories unless the user is applying one of the switch recipes: `recipes/agent/` (agent or model), `recipes/issue-tracker/`, or `recipes/sandbox-provider/`.

## Workflow features

| Feature           | Recipe                      | Notes                                                                                                |
| ----------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| **worktree**      | `recipes/worktree/`         | Named branch + `createSandbox`; review diffs `BRANCH` against `TARGET_BRANCH`, not `BASE_SHA..HEAD`. |
| **planner**       | `recipes/planner/`          | Plan → parallel execute → merge. **Requires worktree first.**                                        |
| _(not a feature)_ | `recipes/sandbox-provider/` | Redo the **init** **sandbox provider** choice (docker ↔ podman ↔ no-sandbox). Not orchestration.     |
| _(not a feature)_ | `recipes/agent/`            | Redo the **init** **agent** choice and its optional **model** (claude-code ↔ pi ↔ codex ↔ cursor ↔ opencode ↔ copilot). Not orchestration. |
| _(not a feature)_ | `recipes/issue-tracker/`    | Redo the **init** **issue tracker** choice (github-issues ↔ beads ↔ custom). Not orchestration.      |

Apply a feature by reading that recipe folder (short README + sliced reference code) and editing the copied files.

## Planner requires worktree

Do not add **planner** on **head**. Parallel execute needs a named **branch** and `createSandbox` per issue. Follow `recipes/worktree/` first, then `recipes/planner/`. Parallel-with-review is worktree + planner; review is already in **standard**.

## Strip review

**standard** includes review. There is no simple-loop recipe. To drop the review phase:

1. Delete the review phase from root `main.ts` / `main.mts` (the `reviewer` `run()`, `BASE_SHA` capture, and the skip/review branch).
2. Delete `review-prompt.md`.
3. Leave implement + idle poll as the loop. The running **workflow template** itself is the reference.

## Switch sandbox provider

Only when the user explicitly asks. Follow `recipes/sandbox-provider/`. That recooks the **init** choice: import/factory (`docker` / `podman` / `noSandbox`), `Dockerfile` vs `Containerfile` vs neither, and no-sandbox host paths for `CODING_STANDARDS.md`.

`createSandbox` belongs to **worktree**, not this recipe. For `docker({ mounts })` / compose, see the Sandcastle README — do not copy the Docker API into the recipe.

## Switch agent or model

Only when the user explicitly asks. Follow `recipes/agent/`. That recooks the **init** choice: the agent factory import and every `agent:` factory call in root `main.ts`, the container file's CLI install, and the `.env` keys. The **model** is the optional factory argument — `factory()` (CLI default) vs `factory("model-id")` — handled in the same recipe; there is no separate model recipe.

## Switch issue tracker

Only when the user explicitly asks. Follow `recipes/issue-tracker/`. That recooks the **init** choice: the list/view/close commands in the prompt files, the `LIST_TASKS_COMMAND` probe in root `main.ts`, the container file's tracker CLI install, and the `.env` keys. Switching to **custom** leaves the project broken-until-configured (`SETUP_ISSUE_TRACKER.md`).

## Do not touch factories unless switching init choices

Root `main.ts` already has the **agent** factory (`claudeCode`, `pi`, …), the **model** argument, the **sandbox provider** factory, and the **issue tracker** commands from **init**. Leave them alone when adding worktree or planner, or when stripping review. Change them only while applying `recipes/agent/` (agent or model), `recipes/issue-tracker/`, or `recipes/sandbox-provider/`.
