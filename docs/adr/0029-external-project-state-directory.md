# External project state directory

## Context

`init` used to place workflow files and runtime artifacts under the target
repository's `.sandcastle/` directory. That makes prompts, runner scripts,
container files, credentials, logs, and temporary worktrees appear as part of
every development checkout, even though they are normally ignored by Git.

The programmatic API already accepts a target repository through `cwd`, so
external workflows need a stable location for Sandcastle-owned state without
changing the repository's Git metadata or source files.

## Decision

`sandcastle init` writes to a per-user cache directory by default:

- Windows: `%LOCALAPPDATA%/Sandcastle/projects/<project-id>/.sandcastle/`
- macOS: `~/Library/Caches/Sandcastle/projects/<project-id>/.sandcastle/`
- Linux: `$XDG_CACHE_HOME/Sandcastle/projects/<project-id>/.sandcastle/`, or
  `~/.cache/Sandcastle/...` when `XDG_CACHE_HOME` is not set

The project id contains a readable repository basename and a hash of its
canonical path, so repositories with the same directory name do not share
state.

The external directory owns the workflow files, `.env`, logs, worktrees, and
patches. Git's worktree metadata remains in the target repository's `.git`
directory because Git owns that metadata.

`--state-dir` overrides the destination. Runtime entry points that omit
`stateDir` use the same per-user cache default, so logs and temporary runtime
artifacts cannot silently return to the repository. Passing
`stateDir: ".sandcastle"` remains an explicit opt-in for callers that want a
repository-local directory. The CLI does not infer or fall back to a
repository-local `.sandcastle`; a CLI project must have a valid external
manifest.

Generated runners resolve their own directory from `import.meta.url`, use the
launching directory as the target repository, and pass absolute prompt paths.
Reviewer workflows mount only the non-sensitive coding-standards file into
container sandboxes; `.env` is resolved as environment and is not mounted as a
file.

## Consequences

- A normal `init` does not create a `.sandcastle` entry in the development
  repository.
- `docker build-image` and `podman build-image` resolve the same external state
  directory and accept `--state-dir` for explicit locations.
- Worktree and patch cleanup must receive the repository directory explicitly;
  their paths can no longer be used to infer the repository by walking up from
  `.sandcastle/worktrees`.
- Users who want to share or review workflow files must explicitly copy or
  export the external state directory; it is intentionally not part of the
  repository checkout.
