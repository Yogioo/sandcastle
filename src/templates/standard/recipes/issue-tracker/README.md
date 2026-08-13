# Issue tracker

**Not a workflow feature.** This recooks the **init** **issue tracker** choice (github-issues ↔ beads ↔ custom). It does not change orchestration (implement/review/planner/worktree), the **agent**, or the **sandbox provider**.

Only apply this when the user explicitly asks to switch **issue tracker**.

The tracker commands are baked into the scaffolded files — there is no runtime abstraction. When switching, edit every file that carries the old tracker's commands.

## File set init already rewrites

| File                                                                                                                                                                   | What changes                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt files — `implement-prompt.md`, plus recipe prompts (`recipes/planner/plan-prompt.md`, `recipes/planner/implement-prompt.md`, `recipes/planner/merge-prompt.md`) | The **list** command (a leading-`!` shell expression), the **view** command, and the **close** command.                                          |
| Planning prompt files — `grill-prompt.md`, `spec-prompt.md`, `tickets-prompt.md`                                                                                       | The planning **list** command, plus the **comment**/**add-label**/**create** commands the planning phases use.                                   |
| Root `main.ts` / `main.mts`                                                                                                                                            | The `LIST_TASKS_COMMAND` const — the host-side idle probe. Must stay identical to the **list** command in the prompts.                           |
| Root `plan.ts` / `plan.mts`                                                                                                                                            | The `LIST_PLANNING_TASKS_COMMAND` const — the planning host probe. Must stay identical to the planning **list** command in the planning prompts. |
| Container file (`Dockerfile` / `Containerfile`, or none for no-sandbox)                                                                                                | The tracker CLI install block.                                                                                                                   |
| `.env`                                                                                                                                                                 | Tracker env keys (uncomment and fill).                                                                                                           |
| `SETUP_ISSUE_TRACKER.md`                                                                                                                                               | Only for **custom** — the setup prompt scaffolded at init.                                                                                       |

## Built-in trackers (init registry)

Implement workflow commands (ready tasks only):

| Tracker           | List                                                                                                                                                                                               | View                                                      | Close                                                      | Container tools                                                                                      | `.env`                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **github-issues** | `gh issue list --state open --label Sandcastle --limit 100 --json number,title,body,labels,comments --jq '[.[] \| {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` | `gh issue view <ID>`                                      | `gh issue close <ID> --comment "Completed by Sandcastle"`  | GitHub CLI via apt (keyring + `apt-get install -y gh`)                                               | `GH_TOKEN` — fine-grained PAT with Issues (read/write) and Metadata (read) |
| **beads**         | `bd ready --exclude-label needs-planning --json`                                                                                                                                                   | `bd show <ID>`                                            | `bd close <ID> --reason="Completed by Sandcastle"`         | system deps (dpkg-dev, libicu72 + .74 symlink), `curl …/beads/install.sh \| bash`, `corepack enable` | none                                                                       |
| **custom**        | sentinel: `echo 'No issue tracker configured — run .sandcastle/SETUP_ISSUE_TRACKER.md through your coding agent.' >&2; exit 1`                                                                     | `<view command — see .sandcastle/SETUP_ISSUE_TRACKER.md>` | `<close command — see .sandcastle/SETUP_ISSUE_TRACKER.md>` | `# TODO: install your issue tracker's CLI here. See .sandcastle/SETUP_ISSUE_TRACKER.md`              | `# TODO: add any env vars your issue tracker needs`                        |

Planning workflow commands (discussion tasks only):

| Tracker           | Planning list                                                                                                                                                                                                           | Comment                                                      | Add label                                                      | Create child                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **github-issues** | `gh issue list --state open --label needs-planning --label -planned --limit 100 --json number,title,body,labels,comments --jq '[.[] \| {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` | `gh issue comment <ID> --body-file <FILE>`                   | `gh issue edit <ID> --add-label <LABEL>`                       | `gh issue create --label Sandcastle --title "<TITLE>" --body-file <FILE>` |
| **beads**         | `bd list --label needs-planning --exclude-label planned`                                                                                                                                                                | `bd comments add <ID>`                                       | `bd label <ID> <LABEL>` (verify with `bd --help`)              | `bd create "<TITLE>"` (verify with `bd --help`)                           |
| **custom**        | sentinel (same shape as the implement list)                                                                                                                                                                             | `<comment command — see .sandcastle/SETUP_ISSUE_TRACKER.md>` | `<add-label command — see .sandcastle/SETUP_ISSUE_TRACKER.md>` | `<create command — see .sandcastle/SETUP_ISSUE_TRACKER.md>`               |

## Switching to custom

**custom** scaffolds broken-until-configured: replace the list/view/close commands with the sentinel and markers above, replace the container tools and `.env` blocks with the `# TODO` versions, and write `SETUP_ISSUE_TRACKER.md` walking your coding agent through wiring the tracker up. Every run hard-fails until that setup completes.

## Steps

1. Replace the **list**, **view**, and **close** commands in every prompt file listed above.
2. Update the `LIST_TASKS_COMMAND` const in root `main.ts` / `main.mts` to the new **list** command — it must match the prompts exactly.
3. Replace the container file's tracker CLI install block (no container file → install on the host) and the `.env` keys.
4. Rebuild the image: `sandcastle docker build-image` (or `sandcastle podman build-image` for podman).

Do not change the **agent** factory or **sandbox** factory while switching tracker.
