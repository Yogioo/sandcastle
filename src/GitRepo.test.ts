import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { initializeGitRepo, inspectGitRepo } from "./GitRepo.js";

const git = (repoDir: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

describe("inspectGitRepo", () => {
  it("reports missing when the directory is not a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-missing-"));
    expect(inspectGitRepo(dir)).toBe("missing");
  });

  it("reports unborn after git init with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-unborn-"));
    git(dir, ["init", "-b", "main"]);
    expect(inspectGitRepo(dir)).toBe("unborn");
  });

  it("reports ready after an initial commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-ready-"));
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "test@test.com"]);
    git(dir, ["config", "user.name", "Test"]);
    git(dir, ["commit", "--allow-empty", "-m", "initial"]);
    expect(inspectGitRepo(dir)).toBe("ready");
  });
});

describe("initializeGitRepo", () => {
  it("creates a repository and initial commit in an empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-init-empty-"));
    initializeGitRepo(dir);
    expect(inspectGitRepo(dir)).toBe("ready");
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("creates an initial commit in an unborn repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-init-unborn-"));
    git(dir, ["init", "-b", "main"]);
    initializeGitRepo(dir);
    expect(inspectGitRepo(dir)).toBe("ready");
  });
});
