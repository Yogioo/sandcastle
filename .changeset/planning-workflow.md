---
"@yogioo/sandcastle": minor
---

Add the planning workflow: `sandcastle plan [path]` runs a sibling `plan.mts`/`plan.ts` entry (scaffolded by the standard template) that drives requirements-discussion issues through grill → spec → tickets phases, one phase per iteration, creating child ready tasks for the implement loop. Blank scaffolds no planning entry; beads implement lists now exclude discussion tasks (`--exclude-label needs-planning`); `init --create-label` also creates the `needs-planning`/`aligned`/`specced`/`planned` labels. See ADR 0031.
