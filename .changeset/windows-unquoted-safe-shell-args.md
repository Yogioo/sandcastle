---
"@yogioo/sandcastle": patch
---

Leave safe model and session identifiers unquoted in agent commands so Windows no-sandbox (cmd.exe) does not pass POSIX quotes through to the CLI.
