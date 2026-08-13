# @yogioo/sandcastle

## 0.14.1

### Patch Changes

- a20f3c2: Register a module resolve hook when `sandcastle` launches a generated runner so `@yogioo/sandcastle` is loaded from the CLI installation instead of the target repository.
- a20f3c2: Prompt during `sandcastle init` to create a git repository with an initial commit when the target has none, and abort init if the user declines.

## 0.14.0

### Minor Changes

- 28cee88: Add `simple-loop-head` and `sequential-reviewer-head` templates, and choose git mode via template instead of an init worktree prompt.

## 0.13.0

### Minor Changes

- fd066e0: Store `sandcastle init` workflow files and runtime state in a per-user project cache by default, with `--state-dir` for explicit locations.

### Patch Changes

- Create a `.env` file automatically during `sandcastle init`.
