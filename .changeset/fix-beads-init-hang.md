---
"@yogioo/sandcastle": patch
---

Fix `sandcastle init` hanging when the beads issue tracker is selected: pass `--remote=` to `bd init` so it no longer auto-links the git origin as a Dolt remote.
