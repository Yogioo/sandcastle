---
"@yogioo/sandcastle": patch
---

fix: Windows no-sandbox Git Bash + Cursor argv; skip resume for non-resumable agents

Windows no-sandbox `exec` now prefers Git Bash so POSIX `shellEscape` quoting
works for multiline prompts (cmd.exe truncated Cursor prompts at `# Context`).
Cursor print-mode on Windows also returns a direct `node.exe`+`index.js` `argv`
so no-sandbox can spawn without the `agent.cmd` `%*` mangler. Container
sandboxes keep using the `agent …` command string inside Linux.

Also: `run()` no longer attaches `sessionId` to `StructuredOutputError` when the
provider has no `sessionStorage`, and the standard workflow template only
attempts `<outcome>` resume when the agent is resumable — fixing
`cursor does not support resumeSession` crashes after a bad outcome.
