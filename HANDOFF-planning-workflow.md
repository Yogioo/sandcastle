# Handoff: Sandcastle planning workflow — IMPLEMENTED

**Repo:** `C:\projects\sandcastle` (worked on at `C:\PYJ\sandcastle`)
**Branch:** `main`
**Date:** 2026-08-13
**Status:** All four TDD seams are implemented, tested, and committed. This file can be deleted.

The work described below was picked up and shipped. Keep this file only if the
original locked decisions (table below) need to be re-checked; the code and
ADR 0031 are now the source of truth.

## What landed (commits on `main`)

| Commit | Slice |
| --- | --- |
| `4ad5996` | Seam 1: `sandcastle plan [path]` — same project resolution as `sandcastle`, spawns `plan.mts`/`plan.ts` derived from the registered `main.*`, explicit error when missing, never starts implement. |
| (seam 2) | Init: standard copies planning entry + three prompts (renamed `plan.mts`→`plan.ts` for ESM, same agent/sandbox rewrite); blank has no planning entry; beads implement list is `bd ready --exclude-label needs-planning --json`; GitHub implement list stays `Sandcastle`-only. |
| (seams 3+4) | `probe.ts` maps labels+comments → `grill`/`spec`/`tickets`/`wait` (agent comments carry `[Sandcastle]`); `plan.mts` runs one `run()` per iteration, idles on `wait` without burning budget, advances `aligned`→spec→tickets with no idle. |
| (prompts) | `grill-prompt.md` / `spec-prompt.md` / `tickets-prompt.md` speak the phase protocols over issue comments; tracker templateArgs gain `LIST_PLANNING_TASKS_COMMAND`, `COMMENT_ON_TASK_COMMAND`, `ADD_LABEL_COMMAND`, `CREATE_TASK_COMMAND`; init `--create-label` also creates the four planning labels. |
| `48c8e3e` + ADR | AGENTS.md / issue-tracker recipe / custom SETUP doc updated; ADR 0031 (`docs/adr/0031-planning-workflow-sibling-entry.md`) records the sibling-process decision. |

## Notable findings while implementing

- **`logs.ts` / `probe.ts` (`.ts` template helpers) load as CJS in repos without `type: module`**, breaking the ESM entry's named imports. Fixed by scaffolding a `{"type":"module"}` package.json into the config directory on every init (also fixes the pre-existing implement-loop hazard).
- **`2>/dev/null` in `gh label create` silently failed under cmd.exe** (Windows `execSync` shell). Removed the redirection; label creation now actually runs, and errors stay best-effort-ignored.
- **Beads `label`/`create` syntax is unverified** (no `bd` on this machine): `bd label <ID> <LABEL>` / `bd create "<TITLE>"` are flagged "verify with `bd --help`" in the recipe README. Beads list (`bd list --label needs-planning --exclude-label planned`) and comments (`bd comments add <ID>`) come from the locked decisions.
- `disable-model-invocation` does not exist in Sandcastle's `run()` API; the prompts instead forbid skill invocations and carry the full protocol themselves.
- The IDE skills (`grill-me`, `to-spec`, `to-tickets`) referenced in the original handoff were not present on this machine (`C:\Users\EDY\...` paths); the locked flow table was used as the behavior spec instead.

## Test baseline note (this Windows machine)

Pre-existing environment failures unrelated to this work: 5 `src/cli.test.ts`
git-init/beads tests (EBUSY temp-dir cleanup, `bd` behavior) and sandbox-path
tests using POSIX container paths (`/home/agent/...` vs `C:\...`). All new
planning tests pass: `src/InitService.test.ts` (163), `src/standard-template-planning-probe.test.ts` (7), `src/standard-template-logs.test.ts` (10).

## Out of scope (unchanged, per the locked decisions)

- Implement-loop behavior (except the beads list exclusion on new scaffolds)
- Cursor Automations
- Merging planning into the implement process
- A second human gate between spec and tickets
