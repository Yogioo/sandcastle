// Agent recipe slice — not a runnable entry.
// Init already rewrote root main.ts to the chosen agent. To switch later,
// change the import and every `agent:` factory call to match:
//   claude-code → import { claudeCode } from "@yogioo/sandcastle"
//   pi          → import { pi } from "@yogioo/sandcastle"
//   codex       → import { codex } from "@yogioo/sandcastle"
//   cursor      → import { cursor } from "@yogioo/sandcastle"
//   opencode    → import { opencode } from "@yogioo/sandcastle"
//   copilot     → import { copilot } from "@yogioo/sandcastle"
//
// The model is the optional factory argument: `pi()` uses the agent CLI's
// default, `pi("model-id")` pins one. Do not change the sandbox factory or
// issue tracker commands while switching agent.

import { claudeCode } from "@yogioo/sandcastle";

export const agent = claudeCode();
