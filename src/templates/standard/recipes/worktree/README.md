# Worktree

**Workflow feature.** Switch **standard** from **head** to a named **branch** plus `createSandbox`, so implement and review share one **sandbox** on that branch.

Apply this before **planner**. `createSandbox` lives here, not in `recipes/sandbox-provider/`.

## Files to change (relative to standard)

| File                   | What changes                                                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts` / `main.mts` | Add `copyToWorktree`. Replace `run({ branchStrategy: { type: "head" } })` with `createSandbox({ branch, copyToWorktree })` then `sandbox.run(...)`. Drop `BASE_SHA` / `git rev-parse HEAD`. Pass `promptArgs: { BRANCH }` to review. `sandbox.close()` in `finally`. |
| `review-prompt.md`     | Replace `{{BASE_SHA}}..HEAD` with `{{TARGET_BRANCH}}...{{BRANCH}}` (see `review-prompt.md` in this folder).                                                                                                                                                          |

Keep the **agent** and **sandbox provider** factories already in root `main.ts`. Copy patterns from `main.mts` here; do not treat this folder as a second runnable entry.

## How review diff changes

**standard** (head) reviews the commit range from this implement pass:

- `git diff {{BASE_SHA}}..HEAD`
- `git log {{BASE_SHA}}..HEAD`

**worktree** reviews the named branch against the fork point (**target branch**):

- `git diff {{TARGET_BRANCH}}...{{BRANCH}}`
- `git log {{TARGET_BRANCH}}..{{BRANCH}}`

`{{SOURCE_BRANCH}}` equals `{{BRANCH}}` at run time, so diffing against it is always empty — use `{{TARGET_BRANCH}}`.
