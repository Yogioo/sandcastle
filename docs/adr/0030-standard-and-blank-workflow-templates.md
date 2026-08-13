# Init ships standard and blank; other shapes are recipes

Maintaining seven init-selectable workflow templates duplicated orchestration that only differed by **branch strategy**, review, or planner topology, and forced users to pick a shape before they had a project. **Init** now copies one of two **workflow templates**: **standard** (the default sequential implement→review loop on **head**) or **blank**. Other orchestration changes are **workflow recipes** under `recipes/`, reached by `@.sandcastle/AGENTS.md` after init, not by a template menu.

This keeps **standard**'s `main.ts` a single simple path (no feature-flag matrix). An agent adds **worktree** or **planner**, or redoes the **sandbox provider** choice, by editing files against the recipe folders. ADR 0009 still holds: **init** copies one self-contained directory; recipes live *inside* **standard**, they are not a `templates/_shared/` module. The init-menu-as-shape-catalog part of ADR 0024 is superseded; the ban on large third-party bundled workflows is not.

## Considered Options

1. **Keep seven init templates** — rejected. Head/worktree and with/without-review twins were copy-paste; the menu was the maintenance surface.
2. **One `main.ts` behind boolean flags** (`USE_WORKTREE`, `USE_PLANNER`) — rejected. Illegal combinations (head + parallel) and a flag junk drawer.
3. **Shared `templates/_shared/` components** — rejected, same reasons as ADR 0009.
4. **Two templates (standard + blank) plus in-tree recipes** (chosen). Init stays a directory copy; users customize after init.

## Consequences

- Interactive init lists **standard** (default) then **blank**. Old names (`sequential-reviewer-head`, `parallel-planner`, …) are not selectable; those directories go away once recipes replace them.
- `recipes/worktree/` and `recipes/planner/` are **workflow features**. `recipes/sandbox-provider/` only redoes docker / podman / no-sandbox; `createSandbox` belongs to worktree.
- Planner requires worktree. Review stays in **standard**; stripping it is documented in `AGENTS.md`, not a `simple-loop` template.
