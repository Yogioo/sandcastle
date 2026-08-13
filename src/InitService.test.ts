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
  validateScaffoldOptions,
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
      templateName: "sequential-reviewer-head",
      sandboxProvider: getSandboxProvider("no-sandbox")!,
    });

    const main = await readFile(join(stateDir, "main.mts"), "utf-8");
    expect(main).toContain(
      'import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox"',
    );
    expect(main).toContain('import.meta.resolve("zod"');
    expect(main).not.toContain('from "@yogioo/sandcastle/sandboxes/docker"');
  });

  it("resolves zod from the host package when the planner lives outside the repo", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");

    await runScaffold(repoDir, {
      stateDir,
      templateName: "parallel-planner",
    });

    const main = await readFile(join(stateDir, "main.mts"), "utf-8");
    expect(main).toContain('import.meta.resolve("zod"');
    expect(main).toContain('from "@yogioo/sandcastle"');
  });

  it("makes reviewer standards visible without exposing the env file", async () => {
    const repoDir = await makeDir();
    const stateDir = join(repoDir, "cache", ".sandcastle");
    const dockerProvider = getSandboxProvider("docker")!;

    await runScaffold(repoDir, {
      stateDir,
      templateName: "sequential-reviewer",
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
      templateName: "sequential-reviewer",
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
    await runScaffold(dir);

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

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "blank" });

    const prompt1 = await readFile(
      join(dir1, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".sandcastle", "prompt.md"),
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

  it("simple-loop template produces main.mts and prompt.md", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const configDir = join(dir, ".sandcastle");
    const { access } = await import("node:fs/promises");

    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("simple-loop main.mts imports from @yogioo/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@yogioo/sandcastle"');
  });

  it("simple-loop main.mts contains sandcastle.run() with expected options", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("3");
    expect(mainTs).toContain("promptFile");
    expect(mainTs).toContain("copyToWorktree");
    expect(mainTs).not.toContain('command: "npm install"');
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

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  describe("sequential-reviewer template", () => {
    it("produces main.mts, implement-prompt.md, and review-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

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
    });

    it("main.mts imports from @yogioo/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@yogioo/sandcastle"');
    });

    it("main.mts uses createSandbox so implementer and reviewer share a sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
    });

    it("main.mts does not use merge-to-head (incompatible with reviewer handoff)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("merge-to-head");
    });

    it("main.mts only reviews when implementer reports done with commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('status === "done"');
      expect(mainTs).toContain("commits.length > 0");
    });

    it("implement-prompt.md contains issue selection and closure, not prompt argument placeholders", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
      expect(prompt).not.toContain("{{ISSUE_TITLE}}");
      expect(prompt).not.toContain("{{BRANCH}}");
    });

    it("implement-prompt.md hints the issue list is pre-filtered and discourages unfiltered re-query", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

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

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("sequential-reviewer appears in listTemplates()", async () => {
      const templates = listTemplates();
      expect(templates.some((t) => t.name === "sequential-reviewer")).toBe(
        true,
      );
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      // Should have guiding comment, not opinionated defaults
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md diffs against {{TARGET_BRANCH}} (the fork point), not the branch itself", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{TARGET_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{TARGET_BRANCH}}..{{BRANCH}}");
      // SOURCE_BRANCH equals BRANCH at run time, so diffing against it is
      // always empty — the prompt must use TARGET_BRANCH instead.
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });

    it("main.mts runs the implementer for a single iteration (one issue per outer pass)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"'),
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 1");
      expect(implementerSection).not.toContain("maxIterations: 100");
    });

    it("main.mts stops the loop when the implementer reports empty with no commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const emptyIndex = mainTs.indexOf(
        'status === "empty" && commits.length === 0',
      );
      expect(emptyIndex).toBeGreaterThan(-1);
      const section = mainTs.slice(emptyIndex, emptyIndex + 400);
      expect(section).toContain("break");
      expect(mainTs).not.toContain("!implement.commits.length");
    });

    it("main.mts resumes once on StructuredOutputError then falls back to git", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("StructuredOutputError");
      expect(mainTs).toContain("resumeSession: error.sessionId");
      expect(mainTs).toContain("MAX_OUTCOME_FAILURES");
      expect(mainTs).toContain("fallbackOutcome");
    });

    it("main.mts extracts a structured <outcome> from the implementer", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("Output.object");
      expect(mainTs).toContain('tag: "outcome"');
      expect(mainTs).toContain('from "zod"');
      expect(mainTs).toContain('"done"');
      expect(mainTs).toContain('"no_change"');
      expect(mainTs).toContain('"blocked"');
      expect(mainTs).toContain('"empty"');
    });

    it("implement-prompt.md instructs the agent to emit <outcome> statuses", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("<outcome>");
      expect(prompt).toContain('"status": "done"');
      expect(prompt).toContain("`no_change`");
      expect(prompt).toContain("`blocked`");
      expect(prompt).toContain("`empty`");
    });
  });

  describe("sequential-reviewer-head template", () => {
    it("appears in listTemplates()", () => {
      expect(
        listTemplates().some((t) => t.name === "sequential-reviewer-head"),
      ).toBe(true);
    });

    it("produces main.mts, implement-prompt.md, review-prompt.md, and CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer-head" });

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
      await runScaffold(dir, { templateName: "sequential-reviewer-head" });

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
      await runScaffold(dir, { templateName: "sequential-reviewer-head" });

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
      await runScaffold(dir, { templateName: "sequential-reviewer-head" });

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

    it("main.mts resumes once on StructuredOutputError then falls back to git", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer-head" });

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
      await runScaffold(dir, { templateName: "sequential-reviewer-head" });

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
      await runScaffold(dir, { templateName: "sequential-reviewer-head" });

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
          templateName: "sequential-reviewer-head",
          useWorktree: false,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("simple-loop-head template", () => {
    it("appears in listTemplates()", () => {
      expect(listTemplates().some((t) => t.name === "simple-loop-head")).toBe(
        true,
      );
    });

    it("produces main.mts and prompt.md with head strategy and no copyToWorktree", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop-head" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "prompt.md")),
      ).resolves.toBeUndefined();

      const mainTs = await readFile(join(configDir, "main.mts"), "utf-8");
      expect(mainTs).toContain('branchStrategy: { type: "head" }');
      expect(mainTs).not.toContain("merge-to-head");
      expect(mainTs).not.toContain("copyToWorktree");
      expect(mainTs).toContain("await run(");
    });

    it("prompt.md contains issue selection shell expressions", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop-head" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("gh issue close");
    });
  });

  it("simple-loop template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

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
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).not.toContain(".env.example");
      expect(joined).toContain("package.json");
      expect(joined).toContain("npm run sandcastle");
    });

    it("non-blank template includes a note about adding an onSandboxReady install command", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("onSandboxReady");
      expect(joined).toContain("install command");
    });

    it("non-blank template mentions copyToWorktree and node_modules", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("copyToWorktree");
      expect(joined).toContain("node_modules");
    });

    it("*-head templates use head-mode next steps even when useWorktree defaults true", () => {
      for (const template of ["simple-loop-head", "sequential-reviewer-head"]) {
        const lines = next(template, "main.mts").join("\n");
        expect(lines).toContain("Head mode");
        expect(lines).not.toContain("copyToWorktree");
      }
    });

    it("sequential-reviewer-head next steps mention CODING_STANDARDS.md", () => {
      const lines = next("sequential-reviewer-head", "main.mts").join("\n");
      expect(lines).toContain("CODING_STANDARDS.md");
    });

    it("blank template includes a step to customize prompt.md", () => {
      const lines = next("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt.md");
    });

    it("simple-loop template includes a step to read/customize prompt files", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("sequential-reviewer template includes a step mentioning prompt files", () => {
      const lines = next("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("parallel-planner template includes a step mentioning prompt files", () => {
      const lines = next("parallel-planner", "main.mts");
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
      const lines = next("simple-loop", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
    });

    it("uses main.ts filename when passed", () => {
      const lines = next("blank", "main.ts");
      const joined = lines.join("\n");
      expect(joined).toContain("main.ts");
      expect(joined).not.toContain("main.mts");
    });

    it("reviewer template mentions CODING_STANDARDS.md customization", () => {
      const lines = next("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("CODING_STANDARDS.md");
    });

    it("non-reviewer template does not mention CODING_STANDARDS.md", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("blank template does not mention CODING_STANDARDS.md", () => {
      const lines = next("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("planner template includes a step to install a schema validator", () => {
      const lines = next("parallel-planner", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install zod");
      expect(joined).toContain("standardschema.dev");
    });

    it("parallel-planner-with-review template includes the schema validator step", () => {
      const lines = next("parallel-planner-with-review", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install zod");
    });

    it("sequential-reviewer templates include the schema validator step", () => {
      expect(next("sequential-reviewer", "main.mts").join("\n")).toContain(
        "npm install zod",
      );
      expect(next("sequential-reviewer-head", "main.mts").join("\n")).toContain(
        "npm install zod",
      );
    });

    it("planner zod step uses the detected package manager's add command", () => {
      expect(next("parallel-planner", "main.mts", "pnpm").join("\n")).toContain(
        "pnpm add zod",
      );
      expect(next("parallel-planner", "main.mts", "yarn").join("\n")).toContain(
        "yarn add zod",
      );
      expect(next("parallel-planner", "main.mts", "bun").join("\n")).toContain(
        "bun add zod",
      );
    });

    it("claude-code agent gets a `claude setup-token` hint under the env-vars step", () => {
      const blank = next("blank", "main.mts").join("\n");
      const nonBlank = next("simple-loop", "main.mts").join("\n");
      expect(blank).toContain("claude setup-token");
      expect(blank).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(nonBlank).toContain("claude setup-token");
      expect(nonBlank).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("non-claude-code agents do not get the `claude setup-token` hint", () => {
      const piLines = getNextStepsLines(
        "simple-loop",
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
      const nonBlank = next("simple-loop", "main.mts").join("\n");
      expect(blank).not.toContain("issues/191");
      expect(nonBlank).not.toContain("issues/191");
    });

    it("non-planner template does not mention installing zod", () => {
      const lines = next("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("zod");
    });

    it("custom issue tracker points at the setup doc and the agent's setup command, regardless of template", () => {
      const lines = getNextStepsLines(
        "simple-loop",
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

  it("simple-loop prompt.md retains --label Sandcastle when createLabel is true", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: true });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label Sandcastle");
  });

  it("simple-loop prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: false });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    // The gh issue list command should still be valid
    expect(prompt).toContain("gh issue list");
    // No double spaces in gh commands from removal
    expect(prompt).not.toMatch(/gh issue list {2}/);
  });

  it("parallel-planner plan-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "parallel-planner",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "plan-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("sequential-reviewer implement-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "sequential-reviewer",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("scaffolded prompts that lack a runtime TASK_ID do not contain {{TASK_ID}}", async () => {
    // Regression test for #477: the {{TASK_ID}} placeholder inside
    // VIEW_TASK_COMMAND / CLOSE_TASK_COMMAND used to leak into prompts
    // whose runtime promptArgs do not include TASK_ID (simple-loop,
    // sequential-reviewer's implement, parallel-planner*'s merge),
    // causing PromptArgumentSubstitution to throw on every iteration.
    const cases: Array<{ template: string; file: string }> = [
      { template: "simple-loop", file: "prompt.md" },
      { template: "sequential-reviewer", file: "implement-prompt.md" },
      { template: "sequential-reviewer-head", file: "implement-prompt.md" },
      { template: "parallel-planner", file: "merge-prompt.md" },
      { template: "parallel-planner-with-review", file: "merge-prompt.md" },
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
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
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

  describe("parallel-planner template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts imports sandcastle and does not default to npm install", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain('command: "npm install"');
      expect(mainTs).toContain("sandcastle");
    });

    it("main.mts imports from @yogioo/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@yogioo/sandcastle"');
    });

    it("main.mts uses no-arg factory calls so the CLI default model is used", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("claudeCode()");
      expect(mainTs).not.toContain('claudeCode("');
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("main.mts always uses the merge agent regardless of branch count", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("completedBranches.length === 1");
    });

    it("common files are still generated with parallel-planner template", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");

      const env = await readFile(join(configDir, ".env"), "utf-8");
      // Dynamic env: claude-code agent → CLAUDE_CODE_OAUTH_TOKEN, default issue tracker → GH_TOKEN
      expect(env).toContain("# CLAUDE_CODE_OAUTH_TOKEN=");
      expect(env).toContain("# GH_TOKEN=");
      expect(uncommentedAssignments(env)).toEqual([]);
    });
  });

  describe("parallel-planner-with-review template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, review-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts imports from @yogioo/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@yogioo/sandcastle"');
    });

    it("main.mts uses createSandbox for shared sandbox per branch", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
    });

    it("main.mts runs implementer then reviewer sequentially within each sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
      expect(mainTs).toContain("implement.commits.length > 0");
    });

    it("main.mts captures reviewer result and merges commits from both runs", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Reviewer result must be captured, not discarded
      expect(mainTs).toContain("const review = await sandbox.run");
      // Commits from both implementer and reviewer must be merged
      expect(mainTs).toContain("implement.commits");
      expect(mainTs).toContain("review.commits");
    });

    it("main.mts uses Promise.allSettled for parallel execution", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("Promise.allSettled");
    });

    it("main.mts has correct maxIterations: planner=1, implementer=100, reviewer=1, merger=1", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Check planner maxIterations: 1 (near "planner" name)
      const plannerSection = mainTs.slice(
        mainTs.indexOf('name: "planner"') - 200,
        mainTs.indexOf('name: "planner"') + 200,
      );
      expect(plannerSection).toContain("maxIterations: 1");

      // Check implementer maxIterations: 100
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"') - 200,
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 100");

      // Check reviewer maxIterations: 1
      const reviewerSection = mainTs.slice(
        mainTs.indexOf('name: "reviewer"') - 200,
        mainTs.indexOf('name: "reviewer"') + 200,
      );
      expect(reviewerSection).toContain("maxIterations: 1");

      // Check merger maxIterations: 1
      const mergerSection = mainTs.slice(
        mainTs.indexOf('name: "merger"') - 200,
        mainTs.indexOf('name: "merger"') + 200,
      );
      expect(mergerSection).toContain("maxIterations: 1");
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("parallel-planner-with-review appears in listTemplates()", () => {
      const templates = listTemplates();
      expect(
        templates.some((t) => t.name === "parallel-planner-with-review"),
      ).toBe(true);
    });

    it("common files are still generated", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");

      const env = await readFile(join(configDir, ".env"), "utf-8");
      // Dynamic env: claude-code agent → CLAUDE_CODE_OAUTH_TOKEN, default issue tracker → GH_TOKEN
      expect(env).toContain("# CLAUDE_CODE_OAUTH_TOKEN=");
      expect(env).toContain("# GH_TOKEN=");
      expect(uncommentedAssignments(env)).toEqual([]);
    });

    it("main.mts uses no-arg factory calls so the CLI default model is used", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("claudeCode()");
      expect(mainTs).not.toContain('claudeCode("');
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md diffs against {{TARGET_BRANCH}} (the fork point), not the branch itself", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{TARGET_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{TARGET_BRANCH}}..{{BRANCH}}");
      // SOURCE_BRANCH equals BRANCH at run time, so diffing against it is
      // always empty — the prompt must use TARGET_BRANCH instead.
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });
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
    it("simple-loop with github-issues produces prompt with gh issue commands (richer version)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("simple-loop with beads produces prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("simple-loop with beads skips --label Sandcastle (no label to strip)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
    });

    it("simple-loop with github-issues retains --label Sandcastle when createLabel is true", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
        createLabel: true,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("--label Sandcastle");
    });

    it("simple-loop with github-issues strips --label Sandcastle when createLabel is false", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
        createLabel: false,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
      expect(prompt).toContain("gh issue list");
    });

    it("scaffold without issueTracker defaults to github-issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      // Should default to github-issues and replace placeholders
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("simple-loop prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    it("simple-loop prompt hints the issue list is pre-filtered and discourages unfiltered re-query", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
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
        templateName: "simple-loop",
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
        templateName: "simple-loop",
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
        templateName: "simple-loop",
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
        templateName: "simple-loop",
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
        templateName: "simple-loop",
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

    it("custom simple-loop prompt hard-fails the list command with a pointer to the doc", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: customManager,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("exit 1");
      expect(prompt).toContain("SETUP_ISSUE_TRACKER.md");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("custom .env carries a TODO for tracker env vars", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: customManager,
      });

      const env = await readFile(join(dir, ".sandcastle", ".env"), "utf-8");
      expect(env).toContain("TODO");
      expect(env).toContain("SETUP_ISSUE_TRACKER.md");
    });

    // --- sequential-reviewer ---

    it("sequential-reviewer with github-issues produces implement-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
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

    it("sequential-reviewer with beads produces implement-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
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

    it("sequential-reviewer implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
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

    // --- parallel-planner ---

    it("parallel-planner with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: z.string()");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner main.mts uses Output.object for the plan", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("Output.object");
      expect(main).toContain('tag: "plan"');
      expect(main).toContain("plan.output.issues");
      expect(main).toContain('from "zod"');
      expect(main).toContain("z.object");
      expect(main).not.toContain("extractPlanIssues");
    });

    it("parallel-planner implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner with beads produces implement-prompt with bd show", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd show");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner with github-issues produces merge-prompt with gh issue close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- parallel-planner-with-review ---

    it("parallel-planner-with-review with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: z.string()");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner-with-review main.mts uses Output.object for the plan", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("Output.object");
      expect(main).toContain('tag: "plan"');
      expect(main).toContain("plan.output.issues");
      expect(main).toContain('from "zod"');
      expect(main).toContain("z.object");
      expect(main).not.toContain("extractPlanIssues");
    });

    it("parallel-planner-with-review implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner-with-review with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces implement-prompt with bd show", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd show");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with github-issues produces merge-prompt with gh issue close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd close");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
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
      await runScaffold(dir);

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
      await runScaffold(dir, { sandboxProvider: podmanProvider });

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

    it("selecting podman rewrites every docker() call site", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        sandboxProvider: podmanProvider,
        templateName: "parallel-planner",
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("docker");
      // parallel-planner calls the factory three times
      expect(mainTs.match(/sandbox: podman\(\)/g)).toHaveLength(3);
    });

    it("selecting docker leaves the main file importing and calling docker", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

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

    it("useWorktree false rewrites simple-loop to head mode without copyToWorktree", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
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

    it("rejects no-worktree for templates that require worktrees", async () => {
      expect(
        validateScaffoldOptions({
          agent: claudeCodeAgent,
          model: "claude-opus-4-8",
          templateName: "parallel-planner",
          useWorktree: false,
        }),
      ).toContain("requires git worktrees");

      expect(
        validateScaffoldOptions({
          agent: claudeCodeAgent,
          model: "claude-opus-4-8",
          templateName: "sequential-reviewer",
          useWorktree: false,
        }),
      ).toContain("requires git worktrees");

      const dir = await makeDir();
      await expect(
        runScaffold(dir, {
          templateName: "sequential-reviewer",
          useWorktree: false,
        }),
      ).rejects.toThrow("requires git worktrees");
    });

    it("allows useWorktree false for head templates", () => {
      expect(
        validateScaffoldOptions({
          agent: claudeCodeAgent,
          model: "claude-opus-4-8",
          templateName: "simple-loop-head",
          useWorktree: false,
        }),
      ).toBeUndefined();
      expect(
        validateScaffoldOptions({
          agent: claudeCodeAgent,
          model: "claude-opus-4-8",
          templateName: "sequential-reviewer-head",
          useWorktree: false,
        }),
      ).toBeUndefined();
    });

    it("no-worktree next steps omit copyToWorktree guidance", () => {
      const lines = getNextStepsLines(
        "simple-loop",
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
