---
"@yogioo/sandcastle": patch
---

fix: resolve session/project dirs with `os.homedir()` instead of `process.env.HOME ?? "~"`

On Windows (PowerShell) `HOME` is unset, so session lookup fell back to a literal
`~\` path and resumeSession always failed with "session not found" even though
the session file existed. `os.homedir()` resolves correctly on every platform.
