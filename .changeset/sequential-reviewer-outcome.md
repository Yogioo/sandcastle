---
"@yogioo/sandcastle": minor
---

Sequential-reviewer templates stop the outer loop on a structured `<outcome>` (`empty` with no commits), not zero commits alone. Invalid `<outcome>` resumes the session once, then falls back to git instead of aborting. `sandbox.run()` now accepts the same `output` option as `run()`.
