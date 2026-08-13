# Agent & model

**Not a workflow feature.** This recooks the **init** **agent** choice (claude-code ↔ pi ↔ codex ↔ cursor ↔ opencode ↔ copilot) and its optional **model**. It does not change orchestration (implement/review/planner/worktree) or the **sandbox provider**.

Only apply this when the user explicitly asks to switch **agent** or **model**.

The **model** is the optional argument to the agent factory: `factory()` uses the agent CLI's default, `factory("model-id")` pins one. Switching model alone is the same recipe — there is no separate model recipe.

## File set init already rewrites

Init writes these from the chosen agent. To switch after init, edit the same set by hand:

| File                                                                                              | What changes                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `main.ts` / `main.mts`                                                                       | The agent factory import from `@yogioo/sandcastle` and every `agent:` factory call (implement and review). `factory()` ↔ `factory("model-id")` for the model.   |
| Container file (`Dockerfile` / `Containerfile`, or none for no-sandbox)                           | The CLI install block for the agent.                                                                                                                            |
| `.env`                                                                                            | The agent's env keys (uncomment and fill).                                                                                                                      |

## Built-in agents (init registry)

| Agent               | Factory      | Container CLI install                                                                             | `.env` keys                                             |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Claude Code         | `claudeCode` | `curl -fsSL https://claude.ai/install.sh \| bash`, then `ENV PATH="/home/agent/.local/bin:$PATH"` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`        |
| Pi                  | `pi`         | `npm install -g @mariozechner/pi-coding-agent`                                                    | `ANTHROPIC_API_KEY`                                     |
| Codex               | `codex`      | `npm install -g @openai/codex`                                                                    | `OPENAI_KEY`                                            |
| Cursor              | `cursor`     | `curl https://cursor.com/install -fsS \| bash`, then `ENV PATH="/home/agent/.local/bin:$PATH"`    | `CURSOR_API_KEY`                                        |
| OpenCode            | `opencode`   | `npm install -g opencode-ai@latest`                                                               | `OPENCODE_API_KEY`                                      |
| GitHub Copilot CLI  | `copilot`    | `npm install -g @github/copilot`                                                                  | `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_TOKEN`) |

## Steps

1. In root `main.ts` / `main.mts`, change the agent factory import from `@yogioo/sandcastle` and every `agent:` factory call (implement and review) to the target's factory. See `factory.mts` in this folder.
2. Replace the container file's CLI install block with the target's install lines from the table above. No container file (no-sandbox) → install the CLI on the host instead.
3. Update `.env` to the target's keys.
4. Rebuild the image: `sandcastle docker build-image` (or `sandcastle podman build-image` for podman).

## Model-only switch

Change only the factory argument, keep the factory: `pi()` → `pi("model-id")`. Omit the argument to go back to the agent CLI's default.

Do not change the **sandbox** factory or **issue tracker** commands while switching agent.
