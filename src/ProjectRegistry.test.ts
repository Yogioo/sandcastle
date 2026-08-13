import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverProjects,
  findProjectByRepo,
  inspectProjectState,
  registerProject,
} from "./ProjectRegistry.js";

const makeDir = () => mkdtemp(join(tmpdir(), "sandcastle-projects-"));

describe("ProjectRegistry", () => {
  it("writes a non-secret manifest and discovers an available project", async () => {
    const root = await makeDir();
    const repoDir = join(root, "repo");
    const stateDir = join(root, "custom-state", ".sandcastle");
    const entryFile = join(stateDir, "main.mts");
    await writeFile(join(root, "repo-marker"), "repo");
    await mkdir(repoDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(entryFile, "export {};\n");

    try {
      const manifest = await registerProject({
        repoDir,
        stateDir,
        entryFile,
        lastUsedAt: "2026-08-12T10:00:00.000Z",
      });

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.repoDir).toBe(resolve(repoDir));
      expect(manifest.stateDir).toBe(resolve(stateDir));
      expect(manifest.entryFile).toBe(resolve(entryFile));
      expect(manifest.lastUsedAt).toBe("2026-08-12T10:00:00.000Z");

      const manifestText = await readFile(
        join(stateDir, "project.json"),
        "utf8",
      );
      expect(manifestText).not.toContain("repo-marker");
      expect(
        await discoverProjects({ projectsRoot: join(root, "cache") }),
      ).toEqual([]);

      const projectsRoot = join(root, "projects");
      const cachedStateDir = join(projectsRoot, "project", ".sandcastle");
      await mkdir(cachedStateDir, { recursive: true });
      await writeFile(join(cachedStateDir, "main.mts"), "export {};\n");
      await mkdir(join(projectsRoot, "orphan", ".sandcastle"), {
        recursive: true,
      });
      await registerProject({
        repoDir,
        stateDir: cachedStateDir,
        entryFile: "main.mts",
      });

      const projects = await discoverProjects({ projectsRoot });
      expect(projects).toHaveLength(1);
      expect(projects[0]?.available).toBe(true);
      expect(projects[0]?.manifest?.repoDir).toBe(resolve(repoDir));
      expect(findProjectByRepo(projects, repoDir)?.stateDir).toBe(
        resolve(cachedStateDir),
      );
      expect(
        findProjectByRepo(projects, relative(process.cwd(), repoDir))?.stateDir,
      ).toBe(resolve(cachedStateDir));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports stale projects without deleting their manifest", async () => {
    const root = await makeDir();
    const stateDir = join(root, "projects", "stale", ".sandcastle");
    const repoDir = join(root, "missing-repo");
    await mkdir(stateDir, { recursive: true });

    try {
      const manifest = await registerProject({
        repoDir,
        stateDir,
        entryFile: "main.mts",
      });

      const project = await inspectProjectState(stateDir);
      expect(project.available).toBe(false);
      expect(project.reason).toContain("repository");
      await expect(
        access(join(stateDir, "project.json")),
      ).resolves.toBeUndefined();
      expect(project.manifest?.id).toBe(manifest.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports malformed manifests as unavailable", async () => {
    const root = await makeDir();
    const stateDir = join(root, "projects", "broken", ".sandcastle");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "project.json"), '{"schemaVersion":99}\n');

    try {
      const project = await inspectProjectState(stateDir);
      expect(project.available).toBe(false);
      expect(project.reason).toContain("schemaVersion");
      await expect(
        access(join(stateDir, "project.json")),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
