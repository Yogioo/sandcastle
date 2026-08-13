---
"@yogioo/sandcastle": patch
---

Run generated workflows with this CLI's `tsx` instead of `npx tsx`, which on Windows could exit 1 with no output. The resolve hook still remaps `@yogioo/sandcastle` and falls back to the host `zod` after default resolution fails, without stealing agent CLI packages.