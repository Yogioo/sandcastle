# `sandcastle plan` is a sibling process, not a planner recipe

The **planning workflow** (grill → spec → tickets on requirements-discussion issues) ships as a first-class CLI entry — `sandcastle plan [path]` — running a sibling entry (`plan.mts` / `plan.ts`) next to the **implement workflow** entry in **standard**. It is not a **workflow recipe** applied after init and not the **planner** recipe (that one is plan → parallel execute → merge for implementation, and already owns the name).

## Context

Two sibling processes share one issue tracker with different list filters:

| Command | Entry | Sees |
| --- | --- | --- |
| `sandcastle` / `sandcastle .` | `main.mts` / `main.ts` | **ready tasks** only |
| `sandcastle plan` / `sandcastle plan .` | `plan.mts` / `plan.ts` | **discussion tasks** only |

A **discussion task** is an issue a human opens for requirements planning (`needs-planning`). The planning phases run as three separate agent sessions: **grill** asks questions as issue comments (the ticket *is* the session — async grilling); when the frontier is empty the agent labels the issue `aligned`; **spec** posts the spec as a comment and labels it `specced`; **tickets** decomposes the spec into child **ready tasks** (implement label), labels the parent `planned`, and leaves it open as the epic. The **implement workflow** never lists the parent; the **planning workflow** never lists **ready tasks**.

Phase isolation lives in the orchestrator: `plan.mts` runs exactly one `run()` per loop iteration. The host probes the planning list between iterations and idles (no sandbox) while waiting on a human — the latest comment lacking the `[Sandcastle]` agent marker means a human replied.

## Considered Options

1. **A third init template (planning)** — rejected. Duplicates the whole orchestration for a difference in list filter; contradicts ADR 0030's two-template split.
2. **A workflow recipe applied after init** — rejected. Planning is a core loop, not an optional shape; recipes are reached by the workflow guide *after* init, and the user wanted `sandcastle plan` first-class.
3. **One process with two loops behind a flag** — rejected. Same feature-flag matrix ADR 0030 banned; the probe, prompts, and tracker commands differ per loop.
4. **Sibling entry in standard (chosen)** — `plan.*` next to `main.*`, same extension, started by `sandcastle plan`. The project manifest stays single-`entryFile` (the implement entry); `plan.*` is derived by convention. Missing `plan.*` (blank template) is an explicit CLI error, never a fallback to the implement entry.

## Consequences

- **standard** scaffolds `plan.*` plus `grill-prompt.md`, `spec-prompt.md`, `tickets-prompt.md`, and `probe.ts` (the phase state machine, unit-tested from `src/` like `logs.ts`). **blank** scaffolds no planning entry.
- `sandcastle plan` resolves projects exactly like `sandcastle`, then spawns the planning entry. Never starts the implement entry.
- Issue-as-session is hard to reverse: the grill/spec phases communicate through issue comments and the `[Sandcastle]` marker, and the label state machine (`needs-planning` → `aligned` → `specced` → `planned`) is baked into the prompts and probe.
- Tracker `templateArgs` gain `LIST_PLANNING_TASKS_COMMAND`, `COMMENT_ON_TASK_COMMAND`, `ADD_LABEL_COMMAND`, and `CREATE_TASK_COMMAND`. The beads implement list excludes discussion tasks (`--exclude-label needs-planning`); the GitHub implement list stays `Sandcastle`-only.
- `sandcastle init --create-label` creates the planning labels alongside `Sandcastle`.
