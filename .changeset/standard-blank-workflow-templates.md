---
"@yogioo/sandcastle": minor
---

Init now copies one of two workflow templates: **standard** (default implement→review loop on head) or **blank**. Other shapes are workflow recipes under `.sandcastle/recipes/`, not init menu entries. The old `simple-loop`, `simple-loop-head`, `sequential-reviewer`, `parallel-planner`, and `parallel-planner-with-review` directories are removed; `--template` with those names (or the old `*-head` names) is no longer selectable.
