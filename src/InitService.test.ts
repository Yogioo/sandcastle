import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getNextStepsLines,
  getAgent,
  listTemplates,
  listIssueTrackers,
  getIssueTracker,
  getSandboxProvider,
} from "./InitService.js";
import type {
  AgentEntry,
  PackageManager,
  ScaffoldOptions,
} from "./InitService.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { SKELETON_PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const uncommentedAssignments = (content: string) =>
  content.split("\n").filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.includes("=")
    );
  });

const claudeCodeAgent = getAgent("claude-code")!;
const piAgent = getAgent("pi")!;
const codexAgent = getAgent("codex")!;
const cursorAgent = getAgent("cursor")!;
const opencodeAgent = getAgent("opencode")!;
const copilotAgent = getAgent("copilot")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

describe("InitService scaffold", () => {
  it("can scaffold into an external state directory without creating repo files", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");

    const result = await runScaffold(repoDir, { stateDir });

    await expect(
      access(join(stateDir, result.mainFilename)),
    ).resolves.toBeUndefined();
    await expect(access(join(repoDir, ".sandcastle"))).rejects.toThrow();

    const main = await readFile(join(stateDir, result.mainFilename), "utf-8");
    expect(main).toContain("workflowDir");
    expect(main).toContain("stateDir: workflowDir");
    expect(main).toContain("promptFile: join(workflowDir");
    expect(main).toContain('from "@yogioo/sandcastle"');
    expect(main).not.toContain("import.meta.resolve");
  });

  it("keeps sandbox provider imports when scaffolding outside the repo", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");

    await runScaffold(repoDir, {
      stateDir,
      templateName: "standard",
      sandboxProvider: getSandboxProvider("no-sandbox")!,
    });

    const main = await readFile(join(stateDir, "main.mts"), "utf-8");
    expect(main).toContain(
      'import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox"',
    );
    expect(main).toContain('from "zod"');
    expect(main).not.toContain("import.meta.resolve");
    expect(main).not.toContain('from "@yogioo/sandcastle/sandboxes/docker"');
  });

  it("keeps a static zod import when the workflow lives outside the repo", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");

    await runScaffold(repoDir, {
      stateDir,
      templateName: "standard",
    });

    const main = await readFile(join(stateDir, "main.mts"), "utf-8");
    expect(main).toContain('from "zod"');
    expect(main).not.toContain("import.meta.resolve");
    expect(main).toContain('from "@yogioo/sandcastle"');
  });

  it("makes reviewer standards visible without exposing the env file", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");
    const dockerProvider = getSandboxProvider("docker")!;

    await runScaffold(repoDir, {
      stateDir,
      templateName: "standard",
      sandboxProvider: dockerProvider,
    });

    const main = await readFile(join(stateDir, "main.mts"), "utf-8");
    const reviewPrompt = await readFile(
      join(stateDir, "review-prompt.md"),
      "utf-8",
    );
    expect(main).toContain("CODING_STANDARDS.md");
    expect(main).toContain('sandboxPath: ".sandcastle/CODING_STANDARDS.md"');
    expect(reviewPrompt).toContain("@.sandcastle/CODING_STANDARDS.md");
  });

  it("uses the host standards path for reviewer no-sandbox scaffolds", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");

    await runScaffold(repoDir, {
      stateDir,
      templateName: "standard",
      sandboxProvider: getSandboxProvider("no-sandbox")!,
    });

    const reviewPrompt = await readFile(
      join(stateDir, "review-prompt.md"),
      "utf-8",
    );
    expect(reviewPrompt).toContain(
      `@${stateDir.replace(/\\/g, "/")}/CODING_STANDARDS.md`,
    );
    expect(reviewPrompt).not.toContain("@.sandcastle/CODING_STANDARDS.md");
  });

  it("makes an external main.ts directory an ESM package", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");
    await writeFile(join(repoDir, "package.json"), '{"type":"module"}');

    const result = await runScaffold(repoDir, { stateDir });

    expect(result.mainFilename).toBe("main.ts");
    expect(await readFile(join(stateDir, "package.json"), "utf-8")).toContain(
      '"type": "module"',
    );
  });

  it("uses agent dockerfileTemplate for Dockerfile (with templateArgs substitution)", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    // Template has {{ISSUE_TRACKER_TOOLS}} replaced — should contain GitHub CLI (default issue tracker)
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("GitHub CLI");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  // --- Dynamic .env generation ---

  it.each([
    {
      agent: claudeCodeAgent,
      expectedKey: "# CLAUDE_CODE_OAUTH_TOKEN=",
      unexpectedKey: "OPENAI_KEY=",
      expectClaudeSetupTokenHint: true,
    },
    {
      agent: piAgent,
      expectedKey: "# ANTHROPIC_API_KEY=",
      unexpectedKey: "OPENAI_KEY=",
      expectClaudeSetupTokenHint: false,
    },
    {
      agent: codexAgent,
      expectedKey: "# OPENAI_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
    {
      agent: opencodeAgent,
      expectedKey: "# OPENCODE_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
    {
      agent: cursorAgent,
      expectedKey: "# CURSOR_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
  ])(
    "generates .env with $agent.name env var commented out",
    async ({
      agent,
      expectedKey,
      unexpectedKey,
      expectClaudeSetupTokenHint,
    }) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const env = await readFile(join(dir, ".sandcastle", ".env"), "utf-8");
      expect(env).toContain(expectedKey);
      expect(env).not.toContain(unexpectedKey);
      expect(env).not.toContain("issues/191");
      expect(uncommentedAssignments(env)).toEqual([]);
      if (expectClaudeSetupTokenHint) {
        expect(env).toContain("claude setup-token");
      } else {
        expect(env).not.toContain("claude setup-token");
      }
    },
  );

  it("does not scaffold .env.example", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    await expect(
      access(join(dir, ".sandcastle", ".env.example")),
    ).rejects.toThrow();
    await expect(
      access(join(dir, ".sandcastle", ".env")),
    ).resolves.toBeUndefined();
  });

  it("generates .env with GH_TOKEN commented out when issue tracker is github-issues", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      issueTracker: getIssueTracker("github-issues"),
    });

    const env = await readFile(join(dir, ".sandcastle", ".env"), "utf-8");
    expect(env).toContain("# GH_TOKEN=");
    expect(env).toContain(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(env).toContain("Issues");
    expect(env).toContain("Metadata");
    expect(uncommentedAssignments(env)).toEqual([]);
  });

  it("generates .env without GH_TOKEN when issue tracker is beads", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      issueTracker: getIssueTracker("beads"),
    });

    const env = await readFile(join(dir, ".sandcastle", ".env"), "utf-8");
    expect(env).not.toContain("GH_TOKEN=");
  });

  it("does not scaffold config.json for blank template", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "config.json")),
    ).rejects.toThrow();
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".sandcastle"));

    await expect(runScaffold(dir)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes all runtime state directories in .gitignore", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain("worktrees/");
    expect(gitignore).toContain("patches/");
  });

  it("Dockerfile template contains worktree mount comment", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_REPO_DIR);
  });

  it.each([
    claudeCodeAgent,
    piAgent,
    codexAgent,
    cursorAgent,
    opencodeAgent,
    copilotAgent,
  ])(
    "$name Dockerfile aligns UID/GID with -o so a host GID colliding with a reserved base-image GID (e.g. macOS staff=20) doesn't fail the build",
    async (agent) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("groupmod -o -g $AGENT_GID node");
      expect(dockerfile).toContain(
        "usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node",
      );
    },
  );

  it("claude-code Dockerfile template does not install pnpm or enable corepack", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).not.toContain("pnpm");
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("# ");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("blank template produces skeleton prompt and main.mts", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const configDir = join(dir, ".sandcastle");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
  });

  it("blank template main.mts imports from @yogioo/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@yogioo/sandcastle"');
  });

  it("blank template main.mts calls run()", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
  });

  it("standard template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "standard" });

    const prompt1 = await readFile(
      join(dir1, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt1).toBe(prompt2);
  });

  // --- main file rewriting ---

  it("scaffolds main.mts with the specified model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('claudeCode("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode()");
  });

  it("scaffolds main.mts with a no-arg factory call when no model is given", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("claudeCode()");
    expect(mainTs).not.toContain('claudeCode("');
  });

  // --- Template-specific tests ---

  it("listTemplates() is only standard and blank, with standard first", () => {
    expect(listTemplates().map((t) => t.name)).toEqual(["standard", "blank"]);
  });

  it("no bundled template runs npm install as an onSandboxReady hook", async () => {
    for (const template of listTemplates()) {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template.name });
      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs, template.name).not.toContain('command: "npm install"');
    }
  });

  describe("workflow recipes (copied with standard)", () => {
    it("copies a file under recipes/worktree/ into the config directory", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      await expect(
        access(join(dir, ".sandcastle", "recipes", "worktree", "README.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(dir, ".sandcastle", "recipes", "worktree", "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(dir, ".sandcastle", "AGENTS.md")),
      ).resolves.toBeUndefined();
    });

    it("copies the agent and issue-tracker switch recipes", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      await expect(
        access(join(dir, ".sandcastle", "recipes", "agent", "README.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(dir, ".sandcastle", "recipes", "agent", "factory.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(
          join(dir, ".sandcastle", "recipes", "issue-tracker", "README.md"),
        ),
      ).resolves.toBeUndefined();
    });

    it("agent recipe lists every built-in agent factory, install, and env key", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const readme = await readFile(
        join(dir, ".sandcastle", "recipes", "agent", "README.md"),
        "utf-8",
      );
      for (const [label, factory, envKey] of [
        ["Claude Code", "claudeCode", "CLAUDE_CODE_OAUTH_TOKEN"],
        ["Pi", "pi", "ANTHROPIC_API_KEY"],
        ["Codex", "codex", "OPENAI_KEY"],
        ["Cursor", "cursor", "CURSOR_API_KEY"],
        ["OpenCode", "opencode", "OPENCODE_API_KEY"],
        ["GitHub Copilot CLI", "copilot", "COPILOT_GITHUB_TOKEN"],
      ]) {
        expect(readme).toContain(label);
        expect(readme).toContain(`\`${factory}\``);
        expect(readme).toContain(envKey);
      }
      // The model is the optional factory argument — one recipe covers both.
      expect(readme).toContain('factory("model-id")');
      expect(readme).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("issue-tracker recipe embeds the built-in trackers' commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const readme = await readFile(
        join(dir, ".sandcastle", "recipes", "issue-tracker", "README.md"),
        "utf-8",
      );
      expect(readme).toContain(
        "gh issue list --state open --label Sandcastle --limit 100",
      );
      expect(readme).toContain(
        'gh issue close <ID> --comment "Completed by Sandcastle"',
      );
      expect(readme).toContain("bd ready --json");
      expect(readme).toContain(
        'bd close <ID> --reason="Completed by Sandcastle"',
      );
      expect(readme).toContain("SETUP_ISSUE_TRACKER.md");
      // Static comparison table — no unresolved template placeholders.
      expect(readme).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("AGENTS.md indexes the agent and issue-tracker switch recipes", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const agentsMd = await readFile(
        join(dir, ".sandcastle", "AGENTS.md"),
        "utf-8",
      );
      // The feature table indexes all three switch recipes.
      expect(agentsMd).toContain("`recipes/agent/`");
      expect(agentsMd).toContain("`recipes/issue-tracker/`");
      expect(agentsMd).toContain("`recipes/sandbox-provider/`");
      // The factory guard maps each init choice to its recipe.
      expect(agentsMd).toContain("`recipes/agent/` (agent or model)");
      expect(agentsMd).toContain("`recipes/issue-tracker/`, or `recipes/sandbox-provider/`");
      // The model is covered by the agent recipe, not a recipe of its own.
      expect(agentsMd).not.toContain("recipes/model/");
    });

    it("substitutes template arguments in recipe prompt files", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "recipes", "planner", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("rewrites agent and sandbox provider on root main and recipe mains", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        agent: piAgent,
        sandboxProvider: getSandboxProvider("no-sandbox")!,
      });

      const rootMain = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(rootMain).toContain(
        'import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox"',
      );
      expect(rootMain).toContain("pi()");
      expect(rootMain).not.toContain("claudeCode");
      expect(rootMain).not.toContain("docker");

      const recipeMain = await readFile(
        join(dir, ".sandcastle", "recipes", "worktree", "main.mts"),
        "utf-8",
      );
      expect(recipeMain).toContain(
        'import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox"',
      );
      expect(recipeMain).toContain("pi()");
      expect(recipeMain).toContain("createSandbox");
      expect(recipeMain).not.toContain("claudeCode");
      expect(recipeMain).not.toContain("docker");
    });

    it("worktree review-prompt diffs BRANCH against TARGET_BRANCH", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "recipes", "worktree", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{TARGET_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{TARGET_BRANCH}}..{{BRANCH}}");
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("planner recipe includes plan/implement/merge prompts and Promise.allSettled", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const { access } = await import("node:fs/promises");
      const plannerDir = join(dir, ".sandcastle", "recipes", "planner");
      await expect(
        access(join(plannerDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(plannerDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(plannerDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();

      const mainTs = await readFile(join(plannerDir, "main.mts"), "utf-8");
      expect(mainTs).toContain("Promise.allSettled");
      expect(mainTs).toContain('tag: "plan"');
    });
  });

  describe("standard template", () => {
    it("appears in listTemplates()", () => {
      expect(listTemplates().some((t) => t.name === "standard")).toBe(true);
    });

    it("produces main.mts, implement-prompt.md, review-prompt.md, and CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "CODING_STANDARDS.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts uses run() with head strategy and no createSandbox({ branch })", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('branchStrategy: { type: "head" }');
      expect(mainTs).toContain("await run(");
      expect(mainTs).not.toMatch(/\bcreateSandbox\s*\(/);
      expect(mainTs).not.toContain("copyToWorktree");
      expect(mainTs).not.toContain("merge-to-head");
    });

    it("main.mts captures BASE_SHA before implement and passes it to review", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("git rev-parse HEAD");
      expect(mainTs).toContain("BASE_SHA: baseSha");
      expect(mainTs).toContain("commits.length");
    });

    it("main.mts stops the loop when the implementer reports empty with no commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('status === "empty" && commits.length === 0');
      expect(mainTs).toContain("break");
      expect(mainTs).not.toContain("!implement.commits.length");
      expect(mainTs).toContain("Output.object");
      expect(mainTs).toContain('tag: "outcome"');
      expect(mainTs).toContain('from "zod"');
    });

    it("main.mts probes the host list before run() and defaults to idle-and-poll", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("const IDLE_POLL_SECONDS = 30;");
      expect(mainTs).toContain("probeReadyTasks");
      expect(mainTs).toContain("while (iteration < MAX_ITERATIONS)");
      expect(mainTs).toContain("iteration += 1");
      expect(mainTs.indexOf("probeReadyTasks")).toBeLessThan(
        mainTs.indexOf("await run("),
      );
      expect(mainTs.indexOf("probed.count <= 0")).toBeLessThan(
        mainTs.indexOf("iteration += 1"),
      );
      expect(mainTs).toContain("gh issue list");
      expect(mainTs).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("main.mts resumes once on StructuredOutputError then falls back to git", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("StructuredOutputError");
      expect(mainTs).toContain("resumeSession: error.sessionId");
      expect(mainTs).toContain("MAX_OUTCOME_FAILURES");
      expect(mainTs).toContain("fallbackOutcome");
    });

    it("implement-prompt.md instructs the agent to emit <outcome> statuses", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("<outcome>");
      expect(prompt).toContain("`no_change`");
      expect(prompt).toContain("`empty`");
    });

    it("review-prompt.md reviews BASE_SHA..HEAD commit range, not worktree branches", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{BASE_SHA}}..HEAD");
      expect(prompt).toContain("git log {{BASE_SHA}}..HEAD");
      expect(prompt).not.toContain("{{BRANCH}}");
      expect(prompt).not.toContain("{{TARGET_BRANCH}}");
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("accepts useWorktree false (head template does not require worktrees)", async () => {
      const dir = await makeDir();
      await expect(
        runScaffold(dir, {
          templateName: "standard",
          useWorktree: false,
        }),
      ).resolves.toBeDefined();
    });
  });

  it("standard template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "standard" });

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, ".sandcastle"));
    const compiledFiles = files.filter(
      (f) =>
        f.endsWith(".js") ||
        f.endsWith(".d.ts") ||
        f.endsWith(".js.map") ||
        f.endsWith(".d.ts.map"),
    );
    expect(compiledFiles).toEqual([]);
  });

  describe("getNextStepsLines", () => {
    const ghIssues = getIssueTracker("github-issues")!;
    const customManager = getIssueTracker("custom")!;
    // Non-custom issue tracker keeps the template-driven next steps; the
    // custom branch is exercised separately below.
    const next = (
      template: string,
      mainFilename: string,
      packageManager: PackageManager = "npm",
    ) =>
      getNextStepsLines(
        template,
        mainFilename,
        ghIssues,
        claudeCodeAgent,
        packageManager,
      );

    it("blank template returns steps mentioning .env and main filename (not npx sandcastle run)", () => {
      const lines = next("blank", "main.mts");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).not.toContain(".env.example");
      expect(joined).toContain("main.mts");
      expect(joined).not.toContain("npx sandcastle run");
    });

    it("non-blank template returns steps mentioning .env, package.json scripts, and npm run sandcastle", () => {
      const lines = next("standard", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).not.toContain(".env.example");
      expect(joined).toContain("package.json");
      expect(joined).toContain("npm run sandcastle");
    });

    it("standard uses head-mode next steps even when useWorktree defaults true", () => {
      const lines = next("standard", "main.mts").join("\n");
      expect(lines).toContain("Head mode");
      expect(lines).not.toContain("copyToWorktree");
    });

    it("standard next steps mention CODING_STANDARDS.md", () => {
      const lines = next("standard", "main.mts").join("\n");
      expect(lines).toContain("CODING_STANDARDS.md");
    });

    it("blank template includes a step to customize prompt.md", () => {
      const lines = next("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt.md");
    });

    it("standard template includes a step to read/customize prompt files", () => {
      const lines = next("standard", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("returns at least 2 numbered steps for blank template", () => {
      const lines = next("blank", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns at least 3 numbered steps for non-blank templates", () => {
      const lines = next("standard", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
    });

    it("uses main.ts filename when passed", () => {
      const lines = next("blank", "main.ts");
      const joined = lines.join("\n");
      expect(joined).toContain("main.ts");
      expect(joined).not.toContain("main.mts");
    });

    it("standard template mentions CODING_STANDARDS.md customization", () => {
      const lines = next("standard", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("CODING_STANDARDS.md");
    });

    it("blank template does not mention CODING_STANDARDS.md", () => {
      const lines = next("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("standard template includes a step to install a schema validator", () => {
      const lines = next("standard", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install zod");
      expect(joined).toContain("standardschema.dev");
    });

    it("standard next steps mention IDLE_POLL_SECONDS and AGENTS.md", () => {
      const head = next("standard", "main.mts").join("\n");
      expect(head).toContain("IDLE_POLL_SECONDS");
      expect(head).toContain("to 0");
      expect(head).toContain("AGENTS.md");
      expect(next("blank", "main.mts").join("\n")).not.toContain(
        "IDLE_POLL_SECONDS",
      );
    });

    it("standard zod step uses the detected package manager's add command", () => {
      expect(next("standard", "main.mts", "pnpm").join("\n")).toContain(
        "pnpm add zod",
      );
      expect(next("standard", "main.mts", "yarn").join("\n")).toContain(
        "yarn add zod",
      );
      expect(next("standard", "main.mts", "bun").join("\n")).toContain(
        "bun add zod",
      );
    });

    it("claude-code agent gets a `claude setup-token` hint under the env-vars step", () => {
      const blank = next("blank", "main.mts").join("\n");
      const nonBlank = next("standard", "main.mts").join("\n");
      expect(blank).toContain("claude setup-token");
      expect(blank).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(nonBlank).toContain("claude setup-token");
      expect(nonBlank).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("non-claude-code agents do not get the `claude setup-token` hint", () => {
      const piLines = getNextStepsLines(
        "standard",
        "main.mts",
        ghIssues,
        piAgent,
        "npm",
      ).join("\n");
      const codexLines = getNextStepsLines(
        "blank",
        "main.mts",
        ghIssues,
        codexAgent,
        "npm",
      ).join("\n");
      expect(piLines).not.toContain("claude setup-token");
      expect(piLines).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(codexLines).not.toContain("claude setup-token");
      expect(codexLines).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("next steps no longer link to the closed issues/191 workaround", () => {
      const blank = next("blank", "main.mts").join("\n");
      const nonBlank = next("standard", "main.mts").join("\n");
      expect(blank).not.toContain("issues/191");
      expect(nonBlank).not.toContain("issues/191");
    });

    it("blank template does not mention installing zod", () => {
      const lines = next("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("zod");
    });

    it("custom issue tracker points at the setup doc and the agent's setup command, regardless of template", () => {
      const lines = getNextStepsLines(
        "standard",
        "main.mts",
        customManager,
        claudeCodeAgent,
        "npm",
      );
      const joined = lines.join("\n");
      expect(joined).toContain("SETUP_ISSUE_TRACKER.md");
      expect(joined).toContain(claudeCodeAgent.setupCommand);
      // The template-driven steps must not leak into the custom branch.
      expect(joined).not.toContain("npm run sandcastle");
    });

    it("custom issue tracker warns the setup command runs on the host", () => {
      const lines = getNextStepsLines(
        "blank",
        "main.mts",
        customManager,
        getAgent("opencode")!,
        "npm",
      );
      const joined = lines.join("\n");
      expect(joined.toLowerCase()).toContain("host");
      expect(joined).toContain(getAgent("opencode")!.setupCommand);
    });
  });

  it("scaffolds pi agent with pi Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it("scaffolds main.mts with pi factory import when pi agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('pi("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds main.mts with pi() when pi is selected and no model is given", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("pi()");
    expect(mainTs).not.toContain('pi("');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds codex agent with codex Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it("scaffolds main.mts with codex factory import when codex agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('codex("gpt-5.4-mini")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds cursor agent with cursor Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: cursorAgent, model: "claude-sonnet-4-6" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).toContain('ENV PATH="/home/agent/.local/bin:$PATH"');
    expect(dockerfile).toContain("ARG AGENT_UID=1000");
    expect(dockerfile).toContain("ARG AGENT_GID=1000");
    expect(dockerfile).toMatch(
      /USER \$\{AGENT_UID\}:\$\{AGENT_GID\}[\s\S]*RUN curl https:\/\/cursor\.com\/install -fsS \| bash/,
    );
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it("scaffolds main.mts with cursor factory import when cursor agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: cursorAgent, model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('cursor("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode");
  });

  // --- createLabel option ---

  it("standard implement-prompt.md retains --label Sandcastle when createLabel is true", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "standard", createLabel: true });

    const prompt = await readFile(
      join(dir, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label Sandcastle");
  });

  it("standard implement-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "standard", createLabel: false });

    const prompt = await readFile(
      join(dir, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
    expect(prompt).not.toMatch(/gh issue list {2}/);
  });

  it("planner recipe plan-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "standard",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "recipes", "planner", "plan-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("standard main.mts strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "standard",
      createLabel: false,
    });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).not.toContain("--label Sandcastle");
    expect(mainTs).toContain("gh issue list");
  });

  it("scaffolded prompts that lack a runtime TASK_ID do not contain {{TASK_ID}}", async () => {
    // Regression test for #477: the {{TASK_ID}} placeholder inside
    // VIEW_TASK_COMMAND / CLOSE_TASK_COMMAND used to leak into prompts
    // whose runtime promptArgs do not include TASK_ID (standard implement,
    // blank prompt),
    // causing PromptArgumentSubstitution to throw on every iteration.
    const cases: Array<{ template: string; file: string }> = [
      { template: "standard", file: "implement-prompt.md" },
      { template: "blank", file: "prompt.md" },
    ];
    for (const { template, file } of cases) {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template });
      const prompt = await readFile(join(dir, ".sandcastle", file), "utf-8");
      expect(prompt, `${template}/${file}`).not.toContain("{{TASK_ID}}");
    }
  });

  it("createLabel defaults to true (label retained when not specified)", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "standard" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label Sandcastle");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  // --- Issue tracker ---

  describe("Issue tracker registry", () => {
    it("listIssueTrackers returns github-issues and beads", () => {
      const managers = listIssueTrackers();
      expect(managers.some((m) => m.name === "github-issues")).toBe(true);
      expect(managers.some((m) => m.name === "beads")).toBe(true);
    });

    it("getIssueTracker returns github-issues entry with expected templateArgs", () => {
      const manager = getIssueTracker("github-issues");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("GitHub Issues");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "gh issue list",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("labels");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("comments");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("--limit 100");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain(
        "gh issue view",
      );
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain(
        "gh issue close",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("GitHub CLI");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("gh");
    });

    it("getIssueTracker returns beads entry with expected templateArgs", () => {
      const manager = getIssueTracker("beads");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("Beads");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toBe("bd ready --json");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("bd show");
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain("bd close");
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain("--reason=");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("beads");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("libicu72");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain(
        "corepack enable",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).not.toContain("gh");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).not.toContain(
        "x86_64-linux-gnu",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain(
        "dpkg-architecture -qDEB_HOST_MULTIARCH",
      );
    });

    it("getIssueTracker returns custom entry with broken-until-configured templateArgs", () => {
      const manager = getIssueTracker("custom");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("Custom");
      // Only the list command is a real shell expression — it hard-fails the
      // run (exit 1) and points at the setup doc.
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("exit 1");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(">&2");
      // View/close are inline text markers, not runnable commands.
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("view command");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain(
        "close command",
      );
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      // Dockerfile install block is a TODO comment pointing at the doc.
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("TODO");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain(
        "SETUP_ISSUE_TRACKER.md",
      );
      expect(manager!.envExample).toContain("TODO");
      expect(manager!.envExample).toContain("SETUP_ISSUE_TRACKER.md");
    });

    it("listIssueTrackers includes custom", () => {
      const managers = listIssueTrackers();
      expect(managers.some((m) => m.name === "custom")).toBe(true);
    });

    it("getIssueTracker returns undefined for unknown manager", () => {
      expect(getIssueTracker("nonexistent")).toBeUndefined();
    });
  });

  describe("Agent setupCommand", () => {
    it.each([
      {
        name: "claude-code",
        command: `claude "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      {
        name: "codex",
        command: `codex "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      {
        name: "cursor",
        command: `agent "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      { name: "pi", command: `pi "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"` },
      {
        name: "opencode",
        command: `opencode --prompt "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
      {
        name: "copilot",
        command: `copilot -i "$(cat .sandcastle/SETUP_ISSUE_TRACKER.md)"`,
      },
    ])(
      "$name has the expected interactive setupCommand",
      ({ name, command }) => {
        expect(getAgent(name)!.setupCommand).toBe(command);
      },
    );
  });

  describe("Issue tracker scaffold", () => {
    it("standard with github-issues produces implement-prompt with gh issue commands (richer version)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("standard with beads produces implement-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("standard with beads skips --label Sandcastle (no label to strip)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
    });

    it("standard with github-issues retains --label Sandcastle when createLabel is true", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("github-issues"),
        createLabel: true,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("--label Sandcastle");
    });

    it("standard with github-issues strips --label Sandcastle when createLabel is false", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("github-issues"),
        createLabel: false,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
      expect(prompt).toContain("gh issue list");
    });

    it("scaffold without issueTracker defaults to github-issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      // Should default to github-issues and replace placeholders
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("standard implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    it("standard implement-prompt hints the issue list is pre-filtered and discourages unfiltered re-query", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(
        "already been filtered to issues ready for work",
      );
      expect(prompt).toContain("sole source of truth");
      expect(prompt).toContain("Do not run your own unfiltered query");
    });

    // --- custom issue tracker ---

    const customManager = getIssueTracker("custom");

    it("custom scaffolds .sandcastle/SETUP_ISSUE_TRACKER.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: customManager,
      });

      const setup = await readFile(
        join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md"),
        "utf-8",
      );
      // Goal + interview + the three commands the agent must produce.
      expect(setup).toContain("list");
      expect(setup).toContain("view");
      expect(setup).toContain("close");
      // It must explicitly tell the agent to remove the exit 1 sentinel.
      expect(setup).toContain("exit 1");
      // The markers the agent will actually find in the scaffolded files.
      expect(setup).toContain(customManager!.templateArgs.VIEW_TASK_COMMAND);
      expect(setup).toContain(customManager!.templateArgs.CLOSE_TASK_COMMAND);
      expect(setup).toContain(".env");
      expect(setup).not.toContain(".env.example");
    });

    it("custom SETUP doc references the chosen provider's build-image command", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: customManager,
        sandboxProvider: getSandboxProvider("podman"),
      });

      const setup = await readFile(
        join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md"),
        "utf-8",
      );
      expect(setup).toContain("sandcastle podman build-image");
      expect(setup).not.toContain("sandcastle docker build-image");
    });

    it("custom host-only setup skips container instructions", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: customManager,
        sandboxProvider: getSandboxProvider("no-sandbox"),
      });

      const setup = await readFile(
        join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md"),
        "utf-8",
      );
      expect(setup).toContain("No Dockerfile or Containerfile");
      expect(setup).toContain("Run your **list** command on the host");
      expect(setup).not.toContain("build-image");
    });

    it("non-custom issue trackers do not scaffold SETUP_ISSUE_TRACKER.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("github-issues"),
      });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md")),
      ).rejects.toThrow();
    });

    it("custom Dockerfile leaves a TODO install block instead of a real CLI", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: customManager,
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("TODO");
      expect(dockerfile).toContain("SETUP_ISSUE_TRACKER.md");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
      // No real issue-tracker CLI baked in yet.
      expect(dockerfile).not.toContain("GitHub CLI");
    });

    it("custom standard implement-prompt hard-fails the list command with a pointer to the doc", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: customManager,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("exit 1");
      expect(prompt).toContain("SETUP_ISSUE_TRACKER.md");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("custom .env carries a TODO for tracker env vars", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: customManager,
      });

      const env = await readFile(join(dir, ".sandcastle", ".env"), "utf-8");
      expect(env).toContain("TODO");
      expect(env).toContain("SETUP_ISSUE_TRACKER.md");
    });

    it("standard main.mts substitutes LIST_TASKS_COMMAND for host-side polling", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("beads"),
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("bd ready --json");
      expect(mainTs).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(mainTs).not.toContain("gh issue list");
    });

    // --- blank ---

    it("blank with github-issues produces prompt with gh issue list example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("blank with beads produces prompt with bd ready example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    // --- planner recipe ---

    it("planner recipe plan-prompt substitutes github-issues list command", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "recipes", "planner", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("planner recipe plan-prompt substitutes beads list command", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "recipes", "planner", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("planner recipe main uses id:string, TASK_ID, and Output.object for the plan", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "standard" });

      const main = await readFile(
        join(dir, ".sandcastle", "recipes", "planner", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: z.string()");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).toContain("Output.object");
      expect(main).toContain('tag: "plan"');
      expect(main).not.toContain("extractPlanIssues");
    });

    it("planner recipe implement-prompt keeps {{TASK_ID}} and substitutes view/close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        issueTracker: getIssueTracker("github-issues"),
      });

      const implement = await readFile(
        join(dir, ".sandcastle", "recipes", "planner", "implement-prompt.md"),
        "utf-8",
      );
      expect(implement).toContain("{{TASK_ID}}");
      expect(implement).toContain("gh issue view");
      expect(implement).not.toContain("{{VIEW_TASK_COMMAND}}");
      expect(implement).not.toContain("{{CLOSE_TASK_COMMAND}}");

      const merge = await readFile(
        join(dir, ".sandcastle", "recipes", "planner", "merge-prompt.md"),
        "utf-8",
      );
      expect(merge).toContain("gh issue close");
      expect(merge).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    // --- Dockerfile issue tracker tools ---

    it("scaffold with github-issues produces Dockerfile with GitHub CLI install", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        issueTracker: getIssueTracker("github-issues"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("GitHub CLI");
      expect(dockerfile).toContain("gh");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });

    it("scaffold with beads produces Dockerfile with beads install (no GitHub CLI)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        issueTracker: getIssueTracker("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("libicu72");
      expect(dockerfile).toContain("corepack enable");
      expect(dockerfile).not.toContain("GitHub CLI");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
      expect(dockerfile).not.toContain("x86_64-linux-gnu");
      expect(dockerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + podman produces Containerfile with beads install", async () => {
      const dir = await makeDir();
      const podmanProvider = getSandboxProvider("podman")!;
      await runScaffold(dir, {
        issueTracker: getIssueTracker("beads"),
        sandboxProvider: podmanProvider,
      });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("beads");
      expect(containerfile).toContain("libicu72");
      expect(containerfile).not.toContain("GitHub CLI");
      expect(containerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
      expect(containerfile).not.toContain("x86_64-linux-gnu");
      expect(containerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + pi agent produces Dockerfile with beads install and pi agent", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        agent: piAgent,
        model: "claude-sonnet-4-6",
        issueTracker: getIssueTracker("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
      expect(dockerfile).not.toContain("GitHub CLI");
    });
  });

  // --- ESM extension detection ---

  describe("main file extension detection", () => {
    it("scaffolds main.mts when no package.json exists", async () => {
      const dir = await makeDir();
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).resolves.toBeUndefined();
    });

    it("scaffolds main.mts when package.json has no type field", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainContent).toContain("@yogioo/sandcastle");
    });

    it("scaffolds main.mts when package.json has type: commonjs", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "commonjs" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });

    it("scaffolds main.ts when package.json has type: module", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.ts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.ts")),
      ).resolves.toBeUndefined();
      // main.mts should NOT exist
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).rejects.toThrow();
    });

    it("main.ts scaffolded with type: module has correct imports and factory calls", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain("@yogioo/sandcastle");
      expect(mainContent).toContain("claudeCode()");
      expect(mainContent).not.toContain('claudeCode("');
    });

    it("main.ts scaffolded with type: module rewrites agent factory correctly", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain('pi("claude-sonnet-4-6")');
      expect(mainContent).not.toContain("claudeCode");
    });

    it("comments in scaffolded main.ts reference main.ts, not main.mts", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir, { templateName: "blank" });

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).not.toContain("main.mts");
      expect(mainContent).toContain("main.ts");
    });

    it("scaffolds main.mts when package.json is invalid JSON", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "package.json"), "not valid json{{{");
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });
  });

  // ---------------------------------------------------------------------------
  // Sandbox provider selection
  // ---------------------------------------------------------------------------

  describe("sandbox provider", () => {
    const dockerProvider = getSandboxProvider("docker")!;
    const podmanProvider = getSandboxProvider("podman")!;

    it("selecting docker writes Dockerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });

    it("selecting podman writes Containerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("FROM node:22-bookworm");
      expect(containerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });

    it("selecting podman does not write Dockerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Dockerfile")),
      ).rejects.toThrow();
    });

    it("selecting docker does not write Containerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Containerfile")),
      ).rejects.toThrow();
    });

    it("selecting podman rewrites the main file to import and call podman", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: podmanProvider,
        templateName: "blank",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'import { podman } from "@yogioo/sandcastle/sandboxes/podman"',
      );
      expect(mainTs).toContain("sandbox: podman()");
      expect(mainTs).not.toContain("docker");
    });

    it("selecting podman rewrites docker() call sites on root and recipe mains", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: podmanProvider,
        templateName: "standard",
      });

      const rootMain = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(rootMain).not.toContain("docker");
      expect(rootMain).toContain("podman(");

      const recipeMain = await readFile(
        join(dir, ".sandcastle", "recipes", "planner", "main.mts"),
        "utf-8",
      );
      expect(recipeMain).not.toContain("docker");
      expect(
        recipeMain.match(/sandbox: podman\(/g)?.length,
      ).toBeGreaterThanOrEqual(3);
    });

    it("selecting docker leaves the main file importing and calling docker", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: dockerProvider,
        templateName: "blank",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'import { run, claudeCode } from "@yogioo/sandcastle"',
      );
      expect(mainTs).toContain(
        'import { docker } from "@yogioo/sandcastle/sandboxes/docker"',
      );
      expect(mainTs).toContain("sandbox: docker()");
    });

    it("selecting no-sandbox does not write Dockerfile or Containerfile", async () => {
      const dir = await makeDir();
      const noSandboxProvider = getSandboxProvider("no-sandbox")!;
      await runScaffold(dir, { sandboxProvider: noSandboxProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Dockerfile")),
      ).rejects.toThrow();
      await expect(
        access(join(dir, ".sandcastle", "Containerfile")),
      ).rejects.toThrow();
    });

    it("selecting no-sandbox rewrites main to import and call noSandbox", async () => {
      const dir = await makeDir();
      const noSandboxProvider = getSandboxProvider("no-sandbox")!;
      await runScaffold(dir, { sandboxProvider: noSandboxProvider });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox"',
      );
      expect(mainTs).toContain("sandbox: noSandbox()");
      expect(mainTs).not.toContain("docker");
    });

    it("useWorktree false keeps standard on head without copyToWorktree", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "standard",
        useWorktree: false,
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('branchStrategy: { type: "head" }');
      expect(mainTs).not.toContain("merge-to-head");
      expect(mainTs).not.toContain("copyToWorktree");
    });

    it("no-worktree next steps omit copyToWorktree guidance", () => {
      const lines = getNextStepsLines(
        "standard",
        "main.mts",
        getIssueTracker("github-issues")!,
        claudeCodeAgent,
        "npm",
        getSandboxProvider("docker")!,
        false,
      ).join("\n");
      expect(lines).not.toContain("copyToWorktree");
      expect(lines).toContain("Head mode");
    });

    it("no-sandbox next steps mention host execution", () => {
      const lines = getNextStepsLines(
        "blank",
        "main.mts",
        getIssueTracker("github-issues")!,
        claudeCodeAgent,
        "npm",
        getSandboxProvider("no-sandbox")!,
        true,
      ).join("\n");
      expect(lines).toContain("host");
      expect(lines).not.toContain("copyToWorktree");
    });
  });
});
