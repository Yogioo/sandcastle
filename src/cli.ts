import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  agentSelectOptions,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  getNextStepsLines,
  detectPackageManager,
  addDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import { resolveCliStateDir, resolveInitStateDir } from "./StateDir.js";
import {
  discoverProjects,
  findProjectByRepo,
  inspectProjectState,
  resolveProjectRepository,
  touchProject,
  type ProjectRecord,
  registerProject,
  unregisterProject,
} from "./ProjectRegistry.js";
import { spawnProjectRunner } from "./ProjectRunner.js";
import type {
  AgentEntry,
  IssueTrackerEntry,
  SandboxProviderEntry,
} from "./InitService.js";
import { ConfigDirError, InitError } from "./errors.js";
import { VERSION } from "./version.js";
import { initializeGitRepo, inspectGitRepo } from "./GitRepo.js";
import {
  initializeBeadsDb,
  inspectBeadsCli,
  inspectBeadsDb,
} from "./BeadsRepo.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const stateDirOption = Options.text("state-dir").pipe(
  Options.withDescription(
    "Sandcastle state directory (defaults to the per-user project cache)",
  ),
  Options.optional,
);

const resolveImageName = (
  cliFlag: Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) args.AGENT_UID = String(uid);
  if (gid !== undefined) args.AGENT_GID = String(gid);
  return args;
};

// --- Config directory check ---

const requireConfigDir = (
  cwd: string,
  stateDir?: string,
): Effect.Effect<string, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDir = resolveCliStateDir(cwd, stateDir);
    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message:
            "No .sandcastle/ found in the external Sandcastle state directory. " +
            `Run \`sandcastle init ${cwd}\` first.`,
        }),
      );
    }
    return configDir;
  });

const optionalRepositoryPath = () =>
  Args.path({ name: "path" }).pipe(Args.optional);

const optionValue = (value: Option.Option<string>): string | undefined =>
  value._tag === "Some" ? value.value : undefined;

const projectOptionLabel = (project: ProjectRecord): string =>
  `${project.name} — ${project.repoDir ?? "(unknown repository)"}`;

const projectOptionHint = (project: ProjectRecord): string =>
  project.available
    ? "available"
    : `unavailable: ${project.reason ?? "unknown reason"}`;

const runRegisteredProject = (
  project: ProjectRecord,
): Effect.Effect<void, ConfigDirError> =>
  Effect.gen(function* () {
    if (
      !project.available ||
      project.manifest === undefined ||
      project.entryFile === undefined ||
      project.repoDir === undefined
    ) {
      yield* Effect.fail(
        new ConfigDirError({
          message:
            `Project "${project.name}" is unavailable: ${project.reason ?? "invalid project manifest"}. ` +
            "Run `sandcastle init <path>` to initialize it again.",
        }),
      );
    }

    yield* Effect.tryPromise({
      try: () => touchProject(project),
      catch: (error) =>
        new ConfigDirError({
          message: `Could not update the project manifest: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    });

    const exitCode = yield* Effect.tryPromise({
      try: () => spawnProjectRunner(project.entryFile!, project.repoDir!),
      catch: (error) =>
        new ConfigDirError({
          message: `Could not start Sandcastle project "${project.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    });
    yield* Effect.sync(() => {
      process.exitCode = exitCode;
    });
  });

const findProjectForPath = (
  repoPath: string,
  stateDir?: string,
): Effect.Effect<ProjectRecord, ConfigDirError> =>
  Effect.gen(function* () {
    const repoDir = resolveProjectRepository(resolve(process.cwd(), repoPath));
    if (stateDir !== undefined) {
      const project = yield* Effect.tryPromise({
        try: () => inspectProjectState(resolve(process.cwd(), stateDir)),
        catch: (error) =>
          new ConfigDirError({
            message: `Could not inspect Sandcastle state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }),
      });
      if (project.repoDir !== undefined) {
        if (findProjectByRepo([project], repoDir) === undefined) {
          yield* Effect.fail(
            new ConfigDirError({
              message:
                `The state directory is registered for "${project.repoDir}", not "${repoDir}". ` +
                `Run \`sandcastle init ${repoDir}\` first.`,
            }),
          );
        }
      }
      return project;
    }

    const projects = yield* Effect.tryPromise({
      try: () => discoverProjects(),
      catch: (error) =>
        new ConfigDirError({
          message: `Could not discover Sandcastle projects: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    });
    const project = findProjectByRepo(projects, repoDir);
    if (project === undefined) {
      yield* Effect.fail(
        new ConfigDirError({
          message:
            `No initialized Sandcastle project found for "${repoDir}". ` +
            `Run \`sandcastle init ${repoDir}\` first.`,
        }),
      );
    }
    return project!;
  });

const selectProject = (
  cwd: string,
  stateDir?: string,
): Effect.Effect<ProjectRecord | undefined, ConfigDirError, Display> =>
  Effect.gen(function* () {
    if (stateDir !== undefined) {
      const project = yield* findProjectForPath(cwd, stateDir);
      return project;
    }

    const projects = yield* Effect.tryPromise({
      try: () => discoverProjects(),
      catch: (error) =>
        new ConfigDirError({
          message: `Could not discover Sandcastle projects: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    });

    if (projects.length === 0) {
      const d = yield* Display;
      yield* d.status(
        "No Sandcastle projects are initialized. Run `sandcastle init [path]` first.",
        "info",
      );
      return undefined;
    }

    const current = findProjectByRepo(projects, cwd);
    if (current?.available) return current;

    const available = projects.filter((project) => project.available);
    if (available.length === 0) {
      const d = yield* Display;
      for (const project of projects) {
        yield* d.text(
          `${projectOptionLabel(project)} — ${projectOptionHint(project)}`,
        );
      }
      yield* d.status(
        "No available Sandcastle projects were found. Run `sandcastle init <path>` to initialize a project.",
        "warn",
      );
      return undefined;
    }

    if (process.stdin.isTTY !== true) {
      const d = yield* Display;
      for (const project of projects) {
        yield* d.text(
          `${projectOptionLabel(project)} — ${projectOptionHint(project)}`,
        );
      }
      yield* Effect.fail(
        new ConfigDirError({
          message:
            "Multiple Sandcastle projects are available, but project selection requires a TTY. " +
            "Run `sandcastle <path>` to choose one explicitly.",
        }),
      );
    }

    const selected = yield* Effect.promise(() =>
      clack.select({
        message: "Select a Sandcastle project:",
        options: projects.map((project) => ({
          value: project.stateDir,
          label: projectOptionLabel(project),
          hint: projectOptionHint(project),
          disabled: !project.available,
        })),
      }),
    );
    if (clack.isCancel(selected)) {
      yield* Effect.fail(
        new ConfigDirError({ message: "Project selection cancelled." }),
      );
    }
    return projects.find((project) => project.stateDir === selected);
  });

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription("Workflow template to scaffold (standard or blank)"),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. claude-code)"),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to pin in the scaffolded factory call (e.g. claude-sonnet-4-6). Omitted uses the agent's CLI default",
  ),
  Options.optional,
);

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription(
    "Sandbox provider to use (docker, podman, or no-sandbox)",
  ),
  Options.optional,
);

const issueTrackerOption = Options.text("issue-tracker").pipe(
  Options.withDescription(
    "Issue tracker to use (e.g. github-issues, beads, custom)",
  ),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const createLabelOption = Options.choice("create-label", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    'Whether to create the "Sandcastle" GitHub label (only meaningful with --issue-tracker github-issues)',
  ),
  Options.optional,
);

const buildImageOption = Options.choice("build-image", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to build the sandbox image now (ignored for custom issue trackers and no-sandbox)",
  ),
  Options.optional,
);

const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for structured-output templates)",
  ),
  Options.optional,
);

const initGitOption = Options.choice("init-git", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to create a git repository and initial commit when the target has none",
  ),
  Options.optional,
);

const initBeadsOption = Options.choice("init-beads", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to run `bd init` when the beads issue tracker is selected and no database exists",
  ),
  Options.optional,
);

const yesOption = Options.boolean("yes", { aliases: ["y"] }).pipe(
  Options.withDescription(
    "Skip the confirmation prompt and delete Sandcastle state immediately",
  ),
);

/**
 * Translate an `Options.choice("flag", ["true", "false"]).optional` value into
 * a tri-state boolean. None when the flag was absent; otherwise the parsed bool.
 */
const choiceToTriBool = (
  opt: Option.Option<"true" | "false">,
): Option.Option<boolean> =>
  opt._tag === "Some" ? Option.some(opt.value === "true") : Option.none();

const initCommand = Command.make(
  "init",
  {
    path: optionalRepositoryPath(),
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    sandbox: sandboxOption,
    issueTracker: issueTrackerOption,
    createLabel: createLabelOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption,
    initGit: initGitOption,
    initBeads: initBeadsOption,
    stateDir: stateDirOption,
  },
  ({
    path: repositoryPath,
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    createLabel: createLabelFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag,
    initGit: initGitFlag,
    initBeads: initBeadsFlag,
    stateDir: stateDirFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = resolveProjectRepository(
        resolve(process.cwd(), optionValue(repositoryPath) ?? process.cwd()),
      );
      const repositoryIsDirectory = yield* Effect.sync(() => {
        try {
          return statSync(cwd).isDirectory();
        } catch {
          return false;
        }
      });
      if (!repositoryIsDirectory) {
        yield* Effect.fail(
          new InitError({
            message: `Repository path "${cwd}" does not exist or is not a directory.`,
          }),
        );
      }
      const imageName = resolveImageName(imageNameFlag, cwd);
      const stateDir = resolveInitStateDir(
        cwd,
        stateDirFlag._tag === "Some" ? stateDirFlag.value : undefined,
      );

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (sandboxFlag._tag === "Some") {
        const valid = getSandboxProvider(sandboxFlag.value);
        if (!valid) {
          const names = listSandboxProviders()
            .map((p) => p.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (issueTrackerFlag._tag === "Some") {
        const valid = getIssueTracker(issueTrackerFlag.value);
        if (!valid) {
          const names = listIssueTrackers()
            .map((t) => t.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      const createLabelChoice = choiceToTriBool(createLabelFlag);
      const buildImageChoice = choiceToTriBool(buildImageFlag);
      const installTemplateDepsChoice = choiceToTriBool(
        installTemplateDepsFlag,
      );
      const initGitChoice = choiceToTriBool(initGitFlag);
      const initBeadsChoice = choiceToTriBool(initBeadsFlag);

      const isInteractive = process.stdin.isTTY === true;
      const failIfNonInteractive = (flag: string) =>
        Effect.fail(
          new InitError({
            message: `${flag} is required in non-interactive mode (no TTY detected).`,
          }),
        );

      // Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
      // fail fast in non-interactive mode naming the missing flag). Cancelling
      // the prompt is treated as abort — same shape as the select prompts above.
      const resolveConfirmFlag = (params: {
        choice: Option.Option<boolean>;
        flag: string;
        promptMessage: string;
        cancelMessage: string;
      }): Effect.Effect<boolean, InitError> =>
        Effect.gen(function* () {
          if (params.choice._tag === "Some") return params.choice.value;
          if (!isInteractive) {
            yield* failIfNonInteractive(params.flag);
          }
          const confirmed = yield* Effect.promise(() =>
            clack.confirm({
              message: params.promptMessage,
              initialValue: true,
            }),
          );
          if (clack.isCancel(confirmed)) {
            yield* Effect.fail(
              new InitError({ message: params.cancelMessage }),
            );
          }
          return confirmed === true;
        });

      const gitStatus = inspectGitRepo(cwd);
      if (gitStatus !== "ready") {
        const shouldInitGit = yield* resolveConfirmFlag({
          choice: initGitChoice,
          flag: "--init-git",
          promptMessage:
            gitStatus === "missing"
              ? "This directory is not a git repository. Create one and make an initial commit now?"
              : "This git repository has no commits yet. Create an initial commit now?",
          cancelMessage: "Git initialization cancelled.",
        });
        if (!shouldInitGit) {
          yield* Effect.fail(
            new InitError({
              message:
                gitStatus === "missing"
                  ? "Sandcastle requires a git repository with at least one commit. Run `git init` and make an initial commit, then re-run `sandcastle init`."
                  : 'Sandcastle requires at least one git commit. Run `git commit --allow-empty -m "Initial commit"`, then re-run `sandcastle init`.',
            }),
          );
        }
        yield* Effect.try({
          try: () => initializeGitRepo(cwd),
          catch: (cause) =>
            new InitError({
              message: `Could not initialize git in "${cwd}": ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* d.status(
          "Created git repository with an initial commit.",
          "success",
        );
      }

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--agent");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an agent:",
            initialValue: "claude-code",
            options: agentSelectOptions(agents),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve model: CLI flag pins a model in main.mts; otherwise omit so
      // the agent's CLI default is used (`pi()`, `claudeCode()`, …).
      const selectedModel =
        modelFlag._tag === "Some" ? modelFlag.value : undefined;

      // Resolve sandbox provider: CLI flag > interactive select (no default — user must choose)
      const sandboxProviders = listSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      if (sandboxFlag._tag === "Some") {
        selectedSandboxProvider = getSandboxProvider(sandboxFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--sandbox");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Resolve issue tracker: CLI flag > interactive select (already validated above)
      const issueTrackers = listIssueTrackers();
      let selectedIssueTracker: IssueTrackerEntry;
      if (issueTrackerFlag._tag === "Some") {
        selectedIssueTracker = getIssueTracker(issueTrackerFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--issue-tracker");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an issue tracker:",
            initialValue: "github-issues",
            options: issueTrackers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Issue tracker selection cancelled.",
            }),
          );
        }
        selectedIssueTracker = getIssueTracker(selected as string)!;
      }

      // Resolve template: CLI flag > interactive select (already validated above)
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--template");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: "standard",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      // standard and blank are head. Worktree is added after init via the
      // worktree recipe. Keep the internal default true so existing
      // rewrite paths stay unchanged.
      const selectedUseWorktree = true;

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub issue trackers).
      // CLI flag > interactive confirm. The flag is only meaningful for the github-issues tracker.
      let shouldCreateLabel = false;
      if (selectedIssueTracker.name === "github-issues") {
        shouldCreateLabel = yield* resolveConfirmFlag({
          choice: createLabelChoice,
          flag: "--create-label",
          promptMessage:
            'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
          cancelMessage: "Label selection cancelled.",
        });

        if (shouldCreateLabel) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
                { cwd, stdio: "ignore" },
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      }

      // Beads needs a host `bd` CLI and a database in the repo. Templates expand
      // `bd ready --json` at runtime, so a missing CLI or uninitialized workspace
      // crashes the first iteration. Mirror --init-git: require the tool, then
      // offer to initialize, and abort init if the user declines.
      if (selectedIssueTracker.name === "beads") {
        if (inspectBeadsCli() === "missing") {
          yield* Effect.fail(
            new InitError({
              message:
                "The beads CLI (`bd`) was not found on PATH. Install it from https://github.com/steveyegge/beads and re-run `sandcastle init`.",
            }),
          );
        }
        if (inspectBeadsDb(cwd) !== "ready") {
          const shouldInitBeads = yield* resolveConfirmFlag({
            choice: initBeadsChoice,
            flag: "--init-beads",
            promptMessage:
              "No beads database found in this repository. Initialize one now (`bd init`)?",
            cancelMessage: "Beads initialization cancelled.",
          });
          if (!shouldInitBeads) {
            yield* Effect.fail(
              new InitError({
                message:
                  "Sandcastle with the beads issue tracker requires a beads database. Run `bd init` in the repository, then re-run `sandcastle init`.",
              }),
            );
          }
          yield* Effect.try({
            try: () => initializeBeadsDb(cwd),
            catch: (cause) =>
              new InitError({
                message: `Could not initialize beads in "${cwd}": ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
          yield* d.status("Initialized beads database.", "success");
        }
      }

      const scaffoldResult = yield* d.spinner(
        "Scaffolding Sandcastle state directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel,
          issueTracker: selectedIssueTracker,
          sandboxProvider: selectedSandboxProvider,
          useWorktree: selectedUseWorktree,
          stateDir,
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );
      yield* Effect.tryPromise({
        try: () =>
          registerProject({
            repoDir: cwd,
            stateDir: scaffoldResult.stateDir,
            entryFile: join(
              scaffoldResult.stateDir,
              scaffoldResult.mainFilename,
            ),
          }),
        catch: (error) =>
          new InitError({
            message: `Could not register the Sandcastle project: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }),
      });
      yield* d.text(`State directory: ${scaffoldResult.stateDir}`);

      // Detect the host package manager so the zod offer below and the next
      // steps below both use the right install command.
      const packageManager = yield* detectPackageManager(cwd);

      // If the chosen template imports zod on the host (standard builds
      // structured-output schemas with it)
      // and the host doesn't already declare it, offer to install it. Without
      // this, the very first `npx tsx .sandcastle/main.ts` crashes with
      // ERR_MODULE_NOT_FOUND.
      if (getTemplateDependencies(selectedTemplate).includes("zod")) {
        const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
        if (!alreadyInstalled) {
          const installCmd = addDependencyCommand(packageManager, "zod");
          const shouldInstall = yield* resolveConfirmFlag({
            choice: installTemplateDepsChoice,
            flag: "--install-template-deps",
            promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
            cancelMessage: "Install-template-deps selection cancelled.",
          });
          if (shouldInstall) {
            const installed = yield* Effect.sync(() => {
              try {
                execSync(installCmd, { cwd, stdio: "ignore" });
                return true;
              } catch {
                return false;
              }
            });
            yield* installed
              ? d.status(`Installed zod with ${packageManager}.`, "success")
              : d.status(
                  `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
                  "warn",
                );
          }
        }
      }

      // Prompt user before building image. The custom issue tracker scaffolds
      // an intentionally unfinished Dockerfile (the install block is a TODO),
      // so there is nothing valid to build yet — skip the build prompt entirely
      // (and silently ignore --build-image) and let the next steps point the
      // user at the setup doc. Host-only (no-sandbox) providers skip the build too.
      const providerLabel = selectedSandboxProvider.label;
      const needsImageBuild =
        selectedSandboxProvider.containerfileName !== null;
      if (selectedIssueTracker.name === "custom") {
        yield* d.status(
          needsImageBuild
            ? "Init complete! Your custom issue tracker isn't configured yet — see the steps below before building."
            : "Init complete! Your custom issue tracker isn't configured yet — see the steps below before running.",
          "success",
        );
      } else if (!needsImageBuild) {
        yield* d.status(
          "Init complete! No container image needed — the agent runs on your host.",
          "success",
        );
      } else {
        const shouldBuild = yield* resolveConfirmFlag({
          choice: buildImageChoice,
          flag: "--build-image",
          promptMessage: `Build the default ${providerLabel} image now?`,
          cancelMessage: "Build-image selection cancelled.",
        });

        if (shouldBuild) {
          const containerfileDir = scaffoldResult.stateDir;
          if (selectedSandboxProvider.name === "podman") {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              podmanBuildImage(imageName, containerfileDir),
            );
          } else {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              buildImage(imageName, containerfileDir, {
                buildArgs: defaultUidBuildArgs(),
              }),
            );
          }
          yield* d.status(
            "Init complete! Image built successfully.",
            "success",
          );
        } else {
          yield* d.status(
            `Init complete! Run \`sandcastle ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
            "success",
          );
        }
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
        selectedIssueTracker,
        selectedAgent,
        packageManager,
        selectedSandboxProvider,
        selectedUseWorktree,
        scaffoldResult.stateDir,
      );
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Path command ---

const pathCommand = Command.make(
  "path",
  {
    path: optionalRepositoryPath(),
    stateDir: stateDirOption,
  },
  ({ path: repositoryPath, stateDir: stateDirFlag }) =>
    Effect.gen(function* () {
      const repoPath = optionValue(repositoryPath) ?? ".";
      const stateDir = optionValue(stateDirFlag);
      const project = yield* findProjectForPath(repoPath, stateDir);
      yield* Effect.sync(() => {
        console.log(project.stateDir);
      });
    }),
);

// --- Delete command ---

const deleteCommand = Command.make(
  "delete",
  {
    path: optionalRepositoryPath(),
    stateDir: stateDirOption,
    yes: yesOption,
  },
  ({ path: repositoryPath, stateDir: stateDirFlag, yes }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const repoPath = optionValue(repositoryPath) ?? ".";
      const stateDir = optionValue(stateDirFlag);
      const project = yield* findProjectForPath(repoPath, stateDir);

      if (!yes) {
        if (process.stdin.isTTY !== true) {
          yield* Effect.fail(
            new ConfigDirError({
              message:
                "--yes is required in non-interactive mode (no TTY detected).",
            }),
          );
        }
        const confirmed = yield* Effect.promise(() =>
          clack.confirm({
            message: `Delete Sandcastle state at ${project.stateDir}?`,
            initialValue: false,
          }),
        );
        if (clack.isCancel(confirmed) || confirmed !== true) {
          yield* Effect.fail(
            new ConfigDirError({ message: "Delete cancelled." }),
          );
        }
      }

      yield* Effect.tryPromise({
        try: () => unregisterProject(project),
        catch: (error) =>
          new ConfigDirError({
            message: `Could not delete Sandcastle state at "${project.stateDir}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          }),
      });
      yield* d.status(
        `Deleted Sandcastle state at ${project.stateDir}.`,
        "success",
      );
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
    stateDir: stateDirOption,
  },
  ({ imageName: imageNameFlag, dockerfile, stateDir: stateDirFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configDir = yield* requireConfigDir(
        cwd,
        stateDirFlag._tag === "Some" ? stateDirFlag.value : undefined,
      );

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = configDir;
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs: defaultUidBuildArgs(),
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
    stateDir: stateDirOption,
  },
  ({ imageName: imageNameFlag, containerfile, stateDir: stateDirFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configDir = yield* requireConfigDir(
        cwd,
        stateDirFlag._tag === "Some" ? stateDirFlag.value : undefined,
      );

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = configDir;
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Root command ---

const rootCommand = Command.make(
  "sandcastle",
  {
    path: optionalRepositoryPath(),
    stateDir: stateDirOption,
  },
  ({ path: repositoryPath, stateDir: stateDirFlag }) =>
    Effect.gen(function* () {
      const stateDir = optionValue(stateDirFlag);
      const repository = optionValue(repositoryPath);
      if (repository !== undefined) {
        const project = yield* findProjectForPath(repository, stateDir);
        yield* runRegisteredProject(project);
        return;
      }

      const project = yield* selectProject(process.cwd(), stateDir);
      if (project !== undefined) {
        yield* runRegisteredProject(project);
      }
    }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    deleteCommand,
    pathCommand,
    dockerCommand,
    podmanCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});
