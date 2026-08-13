---
"@yogioo/sandcastle": patch
---

Stop scaffolding a default `npm install` onSandboxReady hook. Templates no longer assume a Node project; add an install command only if the repo needs one.
