---
"@yogioo/sandcastle": patch
---

Sequential-reviewer templates idle-poll the host issue list every 30s when the backlog is empty instead of exiting. Set `IDLE_POLL_SECONDS` to `0` in the generated `main` for drain-and-stop. Idle waits do not consume `MAX_ITERATIONS` and do not create a sandbox until work exists.
