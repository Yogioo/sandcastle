import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  initializeBeadsDb,
  inspectBeadsCli,
  inspectBeadsDb,
} from "./BeadsRepo.js";

const git = (repoDir: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const makeGitRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "beads-repo-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["commit", "--allow-empty", "-m", "initial"]);
  return dir;
};

const hasBd = (() => {
  try {
    execSync("bd version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("inspectBeadsCli", () => {
  it("reports missing when bd is not on PATH", () => {
    const previousPath = process.env.PATH;
    process.env.PATH = dirname(process.execPath);
    try {
      expect(inspectBeadsCli()).toBe("missing");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it.skipIf(!hasBd)("reports available when bd is on PATH", () => {
    expect(inspectBeadsCli()).toBe("available");
  });
});

describe("inspectBeadsDb", () => {
  it.skipIf(!hasBd)(
    "reports missing when the directory has no beads workspace",
    async () => {
      const dir = await makeGitRepo();
      expect(inspectBeadsDb(dir)).toBe("missing");
    },
  );

  it.skipIf(!hasBd)("reports ready after initializeBeadsDb", async () => {
    const dir = await makeGitRepo();
    initializeBeadsDb(dir);
    expect(inspectBeadsDb(dir)).toBe("ready");
  });
});

describe("initializeBeadsDb", () => {
  it.skipIf(!hasBd)(
    "is idempotent when the workspace already exists",
    async () => {
      const dir = await makeGitRepo();
      initializeBeadsDb(dir);
      initializeBeadsDb(dir);
      expect(inspectBeadsDb(dir)).toBe("ready");
    },
  );
});
