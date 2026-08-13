---
"@yogioo/sandcastle": patch
---

When `sandcastle init` selects the beads issue tracker, require the host `bd` CLI and offer to run `bd init` if the repository has no beads database. Declining cancels init, matching `--init-git`.
