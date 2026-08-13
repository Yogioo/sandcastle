# Planner

**Workflow feature.** Replace the sequential implement loop with plan → parallel execute → merge.

**Depends on worktree.** Apply `recipes/worktree/` first. Parallel execute needs a named **branch** and `createSandbox` per issue; it cannot run on **head**.

Review is already in **standard**. Parallel-with-review is worktree + planner (keep the review phase; run it inside each branch sandbox after implement). Do not look for a separate `parallel-planner-with-review` **workflow template**.

## Files to add or change (relative to standard + worktree)

| File                   | What changes                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan-prompt.md`       | New. Planner reads the issue list and emits `<plan>` JSON.                                                                                                                  |
| `implement-prompt.md`  | Swap sequential pick-an-issue prompt for the per-issue `{{TASK_ID}}` / `{{BRANCH}}` prompt in this folder.                                                                  |
| `merge-prompt.md`      | New. Merge completed branches and close issues.                                                                                                                             |
| `review-prompt.md`     | Keep the worktree `{{BRANCH}}` / `{{TARGET_BRANCH}}` prompt.                                                                                                                |
| `main.ts` / `main.mts` | Plan with `Output.object({ tag: "plan" })`, then `Promise.allSettled` over `createSandbox` + implement (and review), then one merge `run()`. See `main.mts` in this folder. |

Root `main.ts` remains the only runnable entry. Copy patterns from this folder; do not run this `main.mts` directly.

Keep the **agent** and **sandbox provider** factories already written into root `main.ts`.
