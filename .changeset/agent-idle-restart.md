---
"@yogioo/sandcastle": minor
---

Agent idle timeouts now kill the hung process tree and auto-restart the agent with carried-over context. `run()`/`orchestrate()` accept `agentRestartLimit` (default 2 restarts, 0 disables) and `agentRestartDelayMs` (default 15s); each restart re-launches the agent with the previous attempt's output appended to the prompt so verified progress is not lost, and only `AgentIdleTimeoutError` triggers a retry — real failures (non-zero exit) still fail fast.

Fixes the orphaned-process leak behind idle timeouts: exec now wires an `AbortSignal` into the sandbox providers and kills the whole descendant tree (`taskkill /T /F` on Windows, process-group SIGKILL on POSIX) when an attempt is abandoned by the idle timer, the completion-grace timer, or a user abort. Previously the abandoned agent process (e.g. a hung `find /`) kept running after the run failed. no-sandbox, docker, and podman providers are wired; interactive sessions get the same kill-on-abort.
