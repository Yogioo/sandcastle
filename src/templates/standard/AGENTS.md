# Workflow guide

This **config directory** was copied from the **standard** **workflow template**: a sequential implement→review loop on **head** plus the grill→spec→tickets **planning workflow**. `@.sandcastle/AGENTS.md` is this file. Root `main.ts` / `main.mts` is the **implement workflow** entry (`sandcastle`); its sibling `plan.ts` / `plan.mts` is the **planning workflow** entry (`sandcastle plan`). Do not add a feature-flag matrix to either entry.

After **init**, edit files here. **Agent** (+ optional **model**), **sandbox provider**, and **issue tracker** are already written into both root entries. When adapting orchestration, do not change those factories unless the user is applying one of the switch recipes: `recipes/agent/` (agent or model), `recipes/issue-tracker/`, or `recipes/sandbox-provider/`.

## Workflow features

| Feature           | Recipe                      | Notes                                                                                                                                      |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **worktree**      | `recipes/worktree/`         | Named branch + `createSandbox`; review diffs `BRANCH` against `TARGET_BRANCH`, not `BASE_SHA..HEAD`.                                       |
| **planner**       | `recipes/planner/`          | Plan → parallel execute → merge. **Requires worktree first.**                                                                              |
| _(not a feature)_ | `recipes/sandbox-provider/` | Redo the **init** **sandbox provider** choice (docker ↔ podman ↔ no-sandbox). Not orchestration.                                           |
| _(not a feature)_ | `recipes/agent/`            | Redo the **init** **agent** choice and its optional **model** (claude-code ↔ pi ↔ codex ↔ cursor ↔ opencode ↔ copilot). Not orchestration. |
| _(not a feature)_ | `recipes/issue-tracker/`    | Redo the **init** **issue tracker** choice (github-issues ↔ beads ↔ custom). Not orchestration.                                            |

Apply a feature by reading that recipe folder (short README + sliced reference code) and editing the copied files.

## Planning workflow

`sandcastle plan` runs root `plan.ts` / `plan.mts`: the grill→spec→tickets loop on **discussion tasks** (`needs-planning` label). It is a sibling process to the **implement workflow**, not a **workflow feature** and not the **planner** recipe.

- One loop iteration runs exactly one **planning phase** (`grill` → `spec` → `tickets`) as its own agent session. Phase isolation lives in `plan.*`; never merge two phases into one session.
- The host probes the planning list before each phase; waiting on a human idles without a sandbox. The phase state machine and the agent-comment marker live in `probe.ts` (imported by `plan.*`, tested from the Sandcastle repo).
- Agent comments on discussion tasks start with `[Sandcastle]` — the probe uses that marker to tell agent comments from human replies without reading GitHub authors.
- The three phase prompts (`grill-prompt.md`, `spec-prompt.md`, `tickets-prompt.md`) speak the protocol over issue comments; do not replace them with IDE skill invocations.
- Label state machine: `needs-planning` → `aligned` (grill done) → `specced` (spec posted) → `planned` (children created; the parent stays open as the epic).
- Phase logs land in `logs/planning-<pad>-<phase>.log`.

## Planner requires worktree

Do not add **planner** on **head**. Parallel execute needs a named **branch** and `createSandbox` per issue. Follow `recipes/worktree/` first, then `recipes/planner/`. Parallel-with-review is worktree + planner; review is already in **standard**.

## Strip review

**standard** includes review. There is no simple-loop recipe. To drop the review phase:

1. Delete the review phase from root `main.ts` / `main.mts` (the `reviewer` `run()`, `BASE_SHA` capture, and the skip/review branch).
2. Delete `review-prompt.md`.
3. Leave implement + idle poll as the loop. The running **workflow template** itself is the reference.

## Logs

One run directory per process, one loop subdirectory per implement→review cycle that actually starts (under `logs/` in this config directory):

```
logs/run-<yyyyMMdd-HHmmss>/
  main.log                             <- host transcript (terminal is a tee)
  <pad(i)>-<yyyyMMdd-HHmmss>/
    implement.log
    reviewer.log                       <- only when review runs
```

- `main.log` tees the host console. After every implement phase it records a pointer line with the task id, e.g. `01 done sandcastle-i5u → 01-20260813-175241/` — look up a task id there to find its loop directory.
- Idle polls create no loop directory; an `<outcome>` retry appends to the same `implement.log`.
- Timestamps are local machine time; the `pad(i)` width matches the iteration budget (`10` → `01`…`10`). Old run directories are never deleted or rotated.

## Switch sandbox provider

Only when the user explicitly asks. Follow `recipes/sandbox-provider/`. That recooks the **init** choice: import/factory (`docker` / `podman` / `noSandbox`), `Dockerfile` vs `Containerfile` vs neither, and no-sandbox host paths for `CODING_STANDARDS.md`.

`createSandbox` belongs to **worktree**, not this recipe. For `docker({ mounts })` / compose, see the Sandcastle README — do not copy the Docker API into the recipe.

## Switch agent or model

Only when the user explicitly asks. Follow `recipes/agent/`. That recooks the **init** choice: the agent factory import and every `agent:` factory call in root `main.ts`, the container file's CLI install, and the `.env` keys. The **model** is the optional factory argument — `factory()` (CLI default) vs `factory("model-id")` — handled in the same recipe; there is no separate model recipe.

## Switch issue tracker

Only when the user explicitly asks. Follow `recipes/issue-tracker/`. That recooks the **init** choice: the list/view/close commands in the prompt files, the `LIST_TASKS_COMMAND` probe in root `main.ts`, the container file's tracker CLI install, and the `.env` keys. Switching to **custom** leaves the project broken-until-configured (`SETUP_ISSUE_TRACKER.md`).

## Do not touch factories unless switching init choices

Root `main.ts` already has the **agent** factory (`claudeCode`, `pi`, …), the **model** argument, the **sandbox provider** factory, and the **issue tracker** commands from **init**. Leave them alone when adding worktree or planner, or when stripping review. Change them only while applying `recipes/agent/` (agent or model), `recipes/issue-tracker/`, or `recipes/sandbox-provider/`.
