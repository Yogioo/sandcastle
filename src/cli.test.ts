import { exec, execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  initializeBeadsDb,
  inspectBeadsCli,
  inspectBeadsDb,
} from "./BeadsRepo.js";
import { registerProject } from "./ProjectRegistry.js";
import { defaultStateDir } from "./StateDir.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await execAsync('git commit --allow-empty -m "initial commit"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (
  args: string,
  cwd: string,
  envOverrides: NodeJS.ProcessEnv = {},
) =>
  execAsync(`node ${cliPath} ${args}`, {
    cwd,
    env: { ...process.env, ...envOverrides },
  });

const stdoutLines = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const hasBd = inspectBeadsCli() === "available";

/** Beads/Dolt can keep files mapped on Windows after `bd` exits. */
const rmEventually = async (dir: string) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
};

/** PATH with node + git, but not `bd`, so init can still inspect the git repo. */
const pathWithoutBd = (): string => {
  const nodeDir = dirname(process.execPath);
  let gitDir = "";
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const gitPath = execFileSync(locator, ["git"], { encoding: "utf-8" })
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (gitPath) gitDir = dirname(gitPath);
  } catch {
    // git lookup failed — inspectGitRepo will also fail, which the test asserts separately
  }
  const system32 = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32")
    : "";
  return [nodeDir, gitDir, system32].filter(Boolean).join(delimiter);
};

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).toContain("delete");
    expect(stdout).toContain("- path");
    expect(stdout).not.toContain("run");
    expect(stdout).not.toContain("interactive");
    // build-image and remove-image are namespaced under docker, not top-level
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // Old command names should not be exposed
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("docker build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --help shows --template flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--template");
  });

  it("init --help exposes --agent flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--agent");
  });

  it("init --help exposes --model flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--model");
  });

  it("init --help exposes --sandbox flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--sandbox");
  });

  it("init --sandbox nonexistent produces error listing available providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --sandbox nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("docker");
      expect(output).toContain("podman");
    }
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent claude-code --template nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("blank");
      expect(output).toContain("standard");
      expect(output).not.toContain("simple-loop");
      expect(output).not.toContain("sequential-reviewer");
      expect(output).not.toContain("parallel-planner");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    try {
      await runCli("build-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      // Command should fail since build-image is no longer a top-level command
      expect(err).toBeDefined();
    }
  });

  it("old top-level remove-image command no longer works", async () => {
    try {
      await runCli("remove-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("--help shows podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("podman");
    expect(stdout).toContain("podman build-image");
    expect(stdout).toContain("podman remove-image");
  });

  it("podman --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("podman --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman build-image --help shows --containerfile and --image-name flags", async () => {
    const { stdout } = await runCli("podman build-image --help", process.cwd());
    expect(stdout).toContain("--containerfile");
    expect(stdout).toContain("--image-name");
  });

  it("podman build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("podman build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
  });

  it("init --help exposes --issue-tracker flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--issue-tracker");
  });

  it("init --help exposes --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--create-label");
  });

  it("init --help exposes --build-image flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--build-image");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
  });

  it("init --help exposes --state-dir", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--state-dir");
  });

  it("init --help exposes --init-git", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--init-git");
  });

  it("init --help exposes --init-beads", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--init-beads");
  });

  it("init --init-git false aborts when the directory is not a git repository", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-init-git-no-"));

    try {
      await runCli(
        `init "${hostDir}" --init-git false --agent codex --template blank --sandbox no-sandbox --issue-tracker beads`,
        process.cwd(),
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("requires a git repository");
      await expect(readdir(join(hostDir, ".git"))).rejects.toThrow();
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("init without --init-git fails fast on a non-git directory in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-init-git-flag-"));

    try {
      await runCli(
        `init "${hostDir}" --agent codex --template blank --sandbox no-sandbox --issue-tracker beads`,
        process.cwd(),
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--init-git");
      expect(output).toContain("non-interactive");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("init --init-git true creates a git repository and scaffolds", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-init-git-yes-"));
    const stateParent = await mkdtemp(join(tmpdir(), "cli-init-git-state-"));
    const stateDir = join(stateParent, "state");

    try {
      const { stdout } = await runCli(
        `init "${hostDir}" --state-dir "${stateDir}" --init-git true --agent codex --template blank --sandbox no-sandbox --issue-tracker github-issues --create-label false`,
        process.cwd(),
      );

      expect(stdout).toContain("Created git repository");
      expect(stdout).toContain("Init complete");
      await execAsync("git rev-parse --verify HEAD", { cwd: hostDir });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(stateParent, { recursive: true, force: true });
    }
  });

  it("init accepts a repository path and writes its external project manifest", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-path-host-"));
    const stateParent = await mkdtemp(join(tmpdir(), "cli-path-state-"));
    const stateDir = join(stateParent, "state");
    await initRepo(hostDir);

    try {
      await runCli(
        `init "${hostDir}" --state-dir "${stateDir}" --agent codex --template blank --sandbox no-sandbox --issue-tracker github-issues --create-label false`,
        process.cwd(),
      );

      const manifest = JSON.parse(
        await readFile(join(stateDir, "project.json"), "utf8"),
      ) as {
        repoDir: string;
        stateDir: string;
        entryFile: string;
        schemaVersion: number;
      };
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        repoDir: resolve(hostDir),
        stateDir: resolve(stateDir),
      });
      expect(manifest.entryFile).toBe(join(resolve(stateDir), "main.mts"));
      await expect(readdir(join(hostDir, ".sandcastle"))).rejects.toThrow();
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(stateParent, { recursive: true, force: true });
    }
  });

  it("prints an init hint when no external projects exist", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "cli-empty-cache-"));

    try {
      const { stdout } = await runCli("", process.cwd(), {
        LOCALAPPDATA: cacheRoot,
        XDG_CACHE_HOME: cacheRoot,
      });
      expect(stdout).toContain("No Sandcastle projects are initialized");
      expect(stdout).toContain("sandcastle init");
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects relative and absolute uninitialized repository paths with an init hint", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-uninitialized-"));

    try {
      for (const [path, cwd] of [
        [".", hostDir],
        [hostDir, process.cwd()],
      ] as const) {
        try {
          await runCli(path, cwd);
          expect.fail("Expected command to fail");
        } catch (err: unknown) {
          const { stdout, stderr } = err as { stdout: string; stderr: string };
          const output = stdout + stderr;
          expect(output).toContain("sandcastle init");
          expect(output).toContain("No initialized Sandcastle project");
        }
      }
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("shows stale registered projects with a reason without deleting them", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "cli-stale-cache-"));
    const missingRepo = join(cacheRoot, "missing-repository");
    const stateDir = join(
      cacheRoot,
      "Sandcastle",
      "projects",
      "stale",
      ".sandcastle",
    );
    await registerProject({
      repoDir: missingRepo,
      stateDir,
      entryFile: "main.mts",
    });

    try {
      const { stdout } = await runCli("", process.cwd(), {
        LOCALAPPDATA: cacheRoot,
        XDG_CACHE_HOME: cacheRoot,
      });
      expect(stdout).toContain("unavailable");
      expect(stdout).toContain("repository");
      await expect(
        readFile(join(stateDir, "project.json")),
      ).resolves.toBeTruthy();
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("lists available projects when the current directory is not registered", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "cli-select-cache-"));
    const repoDir = await mkdtemp(join(tmpdir(), "cli-select-repo-"));
    const stateDir = join(
      cacheRoot,
      "Sandcastle",
      "projects",
      "available",
      ".sandcastle",
    );
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "main.mts"), "export {};\n");
    await registerProject({
      repoDir,
      stateDir,
      entryFile: "main.mts",
    });

    try {
      await runCli("", process.cwd(), {
        LOCALAPPDATA: cacheRoot,
        XDG_CACHE_HOME: cacheRoot,
      });
      expect.fail("Expected non-TTY selection to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain(repoDir.split(/[\\/]/).at(-1));
      expect(output).toContain("requires a TTY");
      expect(output).toContain("sandcastle <path>");
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("init --issue-tracker nonexistent produces error listing available trackers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --issue-tracker nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("github-issues");
      expect(output).toContain("beads");
      expect(output).toContain("custom");
    }
  });

  it("init --help does not expose a worktree CLI flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).not.toContain("--use-worktree");
  });

  it("init --sandbox no-sandbox scaffolds without Dockerfile", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const stateDir = defaultStateDir(hostDir);
    try {
      const { stdout } = await runCli(
        "init --agent codex --template blank --sandbox no-sandbox --issue-tracker github-issues --create-label false",
        hostDir,
      );

      expect(stdout).toContain("No container image needed");
      const entries = await readdir(stateDir);
      expect(entries).not.toContain("Dockerfile");
      expect(entries).toContain("prompt.md");
      await expect(readdir(join(hostDir, ".sandcastle"))).rejects.toThrow();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("init with full flag set scaffolds non-interactively in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // vitest workers have no TTY, so this confirms the fully-non-interactive
    // path runs to completion without clack crashing on a missing prompt.
    const stateDir = defaultStateDir(hostDir);
    try {
      const { stdout } = await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label false --build-image false",
        hostDir,
      );

      expect(stdout).toContain("Init complete");
      const entries = await readdir(stateDir);
      expect(entries).toContain("Dockerfile");
      expect(entries).toContain("prompt.md");
      await expect(readdir(join(hostDir, ".sandcastle"))).rejects.toThrow();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("init without --agent fails fast with a clear non-interactive error message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --template blank --sandbox docker", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--agent");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker github-issues without --create-label fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--create-label");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker custom ignores --build-image and scaffolds without trying to build", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    // --build-image is meaningless for the custom tracker (Dockerfile is
    // deliberately broken until configured) and must be silently ignored
    // rather than fail-fast or attempt a build.
    const stateDir = defaultStateDir(hostDir);
    try {
      const { stdout } = await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker custom --build-image true",
        hostDir,
      );

      expect(stdout).toContain("Init complete");
      const entries = await readdir(stateDir);
      expect(entries).toContain("SETUP_ISSUE_TRACKER.md");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("init --issue-tracker beads errors when bd is not on PATH", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-beads-no-cli-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent codex --template blank --sandbox no-sandbox --issue-tracker beads --init-beads true",
        hostDir,
        { PATH: pathWithoutBd() },
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("`bd`");
      expect(output).toContain("PATH");
    } finally {
      await rmEventually(hostDir);
    }
  });

  it.skipIf(!hasBd)(
    "init --issue-tracker beads without --init-beads fails fast in non-interactive mode",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-beads-flag-"));
      await initRepo(hostDir);

      try {
        await runCli(
          "init --agent codex --template blank --sandbox no-sandbox --issue-tracker beads",
          hostDir,
        );
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        const output = stdout + stderr;
        expect(output).toContain("--init-beads");
        expect(output).toContain("non-interactive");
      } finally {
        await rmEventually(hostDir);
      }
    },
  );

  it.skipIf(!hasBd)(
    "init --init-beads false aborts when no beads database exists",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-beads-no-"));
      await initRepo(hostDir);

      try {
        await runCli(
          "init --agent codex --template blank --sandbox no-sandbox --issue-tracker beads --init-beads false",
          hostDir,
        );
        expect.fail("Expected command to fail");
      } catch (err: unknown) {
        const { stdout, stderr } = err as { stdout: string; stderr: string };
        expect(stdout + stderr).toContain("requires a beads database");
        expect(inspectBeadsDb(hostDir)).toBe("missing");
      } finally {
        await rmEventually(hostDir);
      }
    },
  );

  it.skipIf(!hasBd)(
    "init --init-beads true initializes a beads database and scaffolds",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-beads-yes-"));
      await initRepo(hostDir);
      const stateDir = defaultStateDir(hostDir);

      try {
        const { stdout } = await runCli(
          "init --agent codex --template blank --sandbox no-sandbox --issue-tracker beads --init-beads true",
          hostDir,
        );

        expect(stdout).toContain("Initialized beads database");
        expect(stdout).toContain("Init complete");
        expect(inspectBeadsDb(hostDir)).toBe("ready");
      } finally {
        await rmEventually(hostDir);
        await rmEventually(stateDir);
      }
    },
    20_000,
  );

  it.skipIf(!hasBd)(
    "init --issue-tracker beads skips --init-beads when a database already exists",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-beads-ready-"));
      await initRepo(hostDir);
      initializeBeadsDb(hostDir);
      const stateDir = defaultStateDir(hostDir);

      try {
        const { stdout } = await runCli(
          "init --agent codex --template blank --sandbox no-sandbox --issue-tracker beads",
          hostDir,
        );

        expect(stdout).toContain("Init complete");
        expect(stdout).not.toContain("Initialized beads database");
      } finally {
        await rmEventually(hostDir);
        await rmEventually(stateDir);
      }
    },
    20_000,
  );

  it("path --help exposes --state-dir", async () => {
    const { stdout } = await runCli("path --help", process.cwd());
    expect(stdout).toContain("--state-dir");
  });

  it("path prints the registered state directory for the current directory", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-path-cwd-"));
    await initRepo(hostDir);
    const stateDir = defaultStateDir(hostDir);

    try {
      await runCli(
        "init --agent codex --template blank --sandbox no-sandbox --issue-tracker custom",
        hostDir,
      );

      const { stdout } = await runCli("path", hostDir);
      expect(stdoutLines(stdout)).toContain(stateDir);

      const dotted = await runCli("path .", hostDir);
      expect(stdoutLines(dotted.stdout)).toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("path accepts a repository path from another directory", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-path-repo-"));
    await initRepo(hostDir);
    const stateDir = defaultStateDir(hostDir);

    try {
      await runCli(
        "init --agent codex --template blank --sandbox no-sandbox --issue-tracker custom",
        hostDir,
      );

      const { stdout } = await runCli(`path "${hostDir}"`, process.cwd());
      expect(stdoutLines(stdout)).toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("path without a registered project fails with an init hint", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-path-missing-"));
    await initRepo(hostDir);

    try {
      await runCli("path .", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No initialized Sandcastle project");
      expect(output).toContain("sandcastle init");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("delete --help exposes --yes", async () => {
    const { stdout } = await runCli("delete --help", process.cwd());
    expect(stdout).toContain("--yes");
  });

  it("delete without a registered project fails with an init hint", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-delete-missing-"));
    await initRepo(hostDir);

    try {
      await runCli("delete --yes", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No initialized Sandcastle project");
      expect(output).toContain("sandcastle init");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("delete without --yes fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-delete-flag-"));
    await initRepo(hostDir);
    const stateDir = defaultStateDir(hostDir);

    try {
      await runCli(
        "init --agent codex --template blank --sandbox no-sandbox --issue-tracker custom",
        hostDir,
      );
      await runCli("delete", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--yes");
      expect(output).toContain("non-interactive");
      await expect(
        access(join(stateDir, "project.json")),
      ).resolves.toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("delete --yes removes Sandcastle state for the current directory", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-delete-yes-"));
    await initRepo(hostDir);
    const stateDir = defaultStateDir(hostDir);

    try {
      await runCli(
        "init --agent codex --template blank --sandbox no-sandbox --issue-tracker custom",
        hostDir,
      );
      await expect(
        access(join(stateDir, "project.json")),
      ).resolves.toBeUndefined();

      const { stdout } = await runCli("delete --yes", hostDir);
      expect(stdout).toContain("Deleted Sandcastle state");
      await expect(access(stateDir)).rejects.toThrow();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});
