# @yogioo/sandcastle

## 0.15.0

### Minor Changes

- 6e0c889: Make agent factory model arguments optional (`pi()`, `claudeCode()`, `codex()`, …) so omitted models use the CLI default instead of a hardcoded Sandcastle string.
- ff044b6: Sequential-reviewer templates stop the outer loop on a structured `<outcome>` (`empty` with no commits), not zero commits alone. Invalid `<outcome>` resumes the session once, then falls back to git instead of aborting. `sandbox.run()` now accepts the same `output` option as `run()`.
- 0d6db2d: Init now copies one of two workflow templates: **standard** (default implement→review loop on head) or **blank**. Other shapes are workflow recipes under `.sandcastle/recipes/`, not init menu entries. The old `simple-loop`, `simple-loop-head`, `sequential-reviewer`, `parallel-planner`, and `parallel-planner-with-review` directories are removed; `--template` with those names (or the old `*-head` names) is no longer selectable.

### Patch Changes

- f4aca77: Print `tail -f` as an absolute path when the log file lives outside the current directory, so cache-dir logs are clickable instead of `..\..\Users\...`.
- 6e0c889: Add `sandcastle path` to print the registered Sandcastle state directory for a repository.
- 6e0c889: Add `sandcastle delete` to remove the registered Sandcastle state directory for a repository so `init` can be re-run cleanly.
- f4aca77: Run generated workflows with this CLI's `tsx` instead of `npx tsx`, which on Windows could exit 1 with no output. The resolve hook still remaps `@yogioo/sandcastle` and falls back to the host `zod` after default resolution fails, without stealing agent CLI packages.
- 6e0c889: When `sandcastle init` selects the beads issue tracker, require the host `bd` CLI and offer to run `bd init` if the repository has no beads database. Declining cancels init, matching `--init-git`.
- a966a52: Scaffold only `.env` during `sandcastle init`, with required keys commented out so users can fill them in. Stop generating `.env.example`.
- bd5cca5: Sequential-reviewer templates idle-poll the host issue list every 30s when the backlog is empty instead of exiting. Set `IDLE_POLL_SECONDS` to `0` in the generated `main` for drain-and-stop. Idle waits do not consume `MAX_ITERATIONS` and do not create a sandbox until work exists.
- 6e0c889: Leave safe model and session identifiers unquoted in agent commands so Windows no-sandbox (cmd.exe) does not pass POSIX quotes through to the CLI.

## 0.14.2

### Patch Changes

- 6c4c9df: Stop scaffolding a default `npm install` onSandboxReady hook. Templates no longer assume a Node project; add an install command only if the repo needs one.

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
