import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  defaultCacheRoot,
  STATE_DIR_NAME,
  type StateDirectoryEnvironment,
  projectStateId,
} from "./StateDir.js";

export const PROJECT_MANIFEST_FILENAME = "project.json";
export const PROJECT_MANIFEST_SCHEMA_VERSION = 1;

export interface ProjectManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly repoDir: string;
  readonly stateDir: string;
  readonly entryFile: string;
  readonly lastUsedAt: string;
}

export interface ProjectRecord {
  readonly stateDir: string;
  readonly manifest?: ProjectManifest;
  readonly name: string;
  readonly repoDir?: string;
  readonly entryFile?: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface RegisterProjectOptions {
  readonly repoDir: string;
  readonly stateDir: string;
  readonly entryFile: string;
  readonly name?: string;
  readonly lastUsedAt?: string;
}

export interface DiscoverProjectsOptions {
  /**
   * Override the cache's `Sandcastle/projects` directory. This is primarily
   * useful for tests; normal callers should use the per-user cache default.
   */
  readonly projectsRoot?: string;
  readonly environment?: StateDirectoryEnvironment;
}

const canonicalPath = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

export const resolveProjectRepository = (repoDir: string): string =>
  canonicalPath(repoDir);

const comparablePath = (path: string): string => {
  const normalized = resolve(path).replace(/[\\/]+/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const samePath = (left: string, right: string): boolean =>
  comparablePath(left) === comparablePath(right);

const manifestPath = (stateDir: string): string =>
  join(stateDir, PROJECT_MANIFEST_FILENAME);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const invalid = (reason: string): { manifest?: never; reason: string } => ({
  reason,
});

const parseManifest = (
  value: unknown,
  stateDir: string,
): { manifest: ProjectManifest } | { manifest?: never; reason: string } => {
  if (!isRecord(value)) return invalid("project.json must contain an object");
  if (value.schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    return invalid(
      `unsupported schemaVersion ${String(value.schemaVersion)} (expected ${PROJECT_MANIFEST_SCHEMA_VERSION})`,
    );
  }

  const requiredStrings = [
    "id",
    "name",
    "repoDir",
    "stateDir",
    "entryFile",
    "lastUsedAt",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      return invalid(
        `project.json field "${field}" must be a non-empty string`,
      );
    }
  }

  const manifest: ProjectManifest = {
    schemaVersion: 1,
    id: value.id as string,
    name: value.name as string,
    repoDir: value.repoDir as string,
    stateDir: value.stateDir as string,
    entryFile: value.entryFile as string,
    lastUsedAt: value.lastUsedAt as string,
  };

  if (!samePath(manifest.stateDir, stateDir)) {
    return invalid(
      "project.json stateDir does not match its containing directory",
    );
  }
  if (manifest.id !== projectStateId(manifest.repoDir)) {
    return invalid("project.json id does not match repoDir");
  }

  return { manifest };
};

const readRawManifest = async (
  stateDir: string,
): Promise<
  | { readonly value: unknown }
  | { readonly missing: true }
  | { readonly error: string }
> => {
  try {
    const content = await readFile(manifestPath(stateDir), "utf8");
    try {
      return { value: JSON.parse(content) as unknown };
    } catch {
      return { error: "project.json is not valid JSON" };
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { missing: true };
    }
    return {
      error: `could not read project.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const availability = async (
  manifest: ProjectManifest,
): Promise<{ available: true } | { available: false; reason: string }> => {
  try {
    const repo = await stat(manifest.repoDir);
    if (!repo.isDirectory()) {
      return {
        available: false,
        reason: `repository path is not a directory: ${manifest.repoDir}`,
      };
    }
  } catch {
    return {
      available: false,
      reason: `repository is unavailable: ${manifest.repoDir}`,
    };
  }

  try {
    const entry = await stat(manifest.entryFile);
    if (!entry.isFile()) {
      return {
        available: false,
        reason: `entry file is not a file: ${manifest.entryFile}`,
      };
    }
  } catch {
    return {
      available: false,
      reason: `entry file is unavailable: ${manifest.entryFile}`,
    };
  }

  return { available: true };
};

const fallbackName = (stateDir: string): string =>
  basename(resolve(stateDir, "..")) || "unknown project";

/**
 * Inspect one external state directory without changing or deleting it.
 */
export const inspectProjectState = async (
  stateDir: string,
): Promise<ProjectRecord> => {
  const resolvedStateDir = resolve(stateDir);
  const raw = await readRawManifest(resolvedStateDir);
  if ("missing" in raw) {
    return {
      stateDir: resolvedStateDir,
      name: fallbackName(resolvedStateDir),
      available: false,
      reason: `missing ${PROJECT_MANIFEST_FILENAME}`,
    };
  }
  if ("error" in raw) {
    return {
      stateDir: resolvedStateDir,
      name: fallbackName(resolvedStateDir),
      available: false,
      reason: raw.error,
    };
  }

  const parsed = parseManifest(raw.value, resolvedStateDir);
  if (!parsed.manifest) {
    const possibleName =
      isRecord(raw.value) && typeof raw.value.name === "string"
        ? raw.value.name
        : fallbackName(resolvedStateDir);
    return {
      stateDir: resolvedStateDir,
      name: possibleName,
      available: false,
      reason: parsed.reason,
    };
  }

  const project = parsed.manifest;
  const status = await availability(project);
  return {
    stateDir: resolvedStateDir,
    manifest: project,
    name: project.name,
    repoDir: project.repoDir,
    entryFile: project.entryFile,
    ...status,
  };
};

/**
 * Register a project after its generated entry and configuration exist.
 *
 * The manifest contains only routing metadata. Credentials and runtime files
 * stay in the state directory and are never copied into project.json.
 */
export const registerProject = async (
  options: RegisterProjectOptions,
): Promise<ProjectManifest> => {
  const repoDir = resolveProjectRepository(options.repoDir);
  const stateDir = resolve(options.stateDir);
  const entryFile = resolve(stateDir, options.entryFile);
  const manifest: ProjectManifest = {
    schemaVersion: 1,
    id: projectStateId(repoDir),
    name: options.name ?? basename(repoDir),
    repoDir,
    stateDir,
    entryFile,
    lastUsedAt: options.lastUsedAt ?? new Date().toISOString(),
  };

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    manifestPath(stateDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
};

/**
 * Update only the last-used timestamp for a registered project.
 */
/**
 * Remove a project's Sandcastle state directory.
 *
 * When the state lives at the default cache layout
 * (`…/projects/<id>/.sandcastle`), the now-empty `<id>` folder is removed too.
 */
export const unregisterProject = async (
  project: ProjectRecord,
): Promise<void> => {
  const stateDir = resolve(project.stateDir);
  await rm(stateDir, { recursive: true, force: true });
  if (basename(stateDir) !== STATE_DIR_NAME) return;

  const projectDir = dirname(stateDir);
  let remaining: string[];
  try {
    remaining = await readdir(projectDir);
  } catch {
    return;
  }
  if (remaining.length === 0) {
    await rm(projectDir, { recursive: true, force: true });
  }
};

export const touchProject = async (
  project: ProjectRecord,
  lastUsedAt = new Date().toISOString(),
): Promise<ProjectManifest | undefined> => {
  if (!project.manifest) return undefined;
  return registerProject({
    repoDir: project.manifest.repoDir,
    stateDir: project.manifest.stateDir,
    entryFile: project.manifest.entryFile,
    name: project.manifest.name,
    lastUsedAt,
  });
};

/**
 * Discover project state directories in the per-user Sandcastle cache.
 *
 * Discovery deliberately reports malformed and stale entries instead of
 * pruning them. A missing repository can become available again later.
 */
export const discoverProjects = async (
  options: DiscoverProjectsOptions = {},
): Promise<ProjectRecord[]> => {
  const projectsRoot = resolve(
    options.projectsRoot ??
      join(defaultCacheRoot(options.environment), "Sandcastle", "projects"),
  );

  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const projects: ProjectRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = await inspectProjectState(
      join(projectsRoot, entry.name, STATE_DIR_NAME),
    );
    // A directory left behind by an interrupted or pre-registry init is not a
    // registered project. Only manifests participate in selection; malformed
    // manifests remain visible as stale entries.
    if (
      project.manifest !== undefined ||
      !project.reason?.startsWith("missing ")
    ) {
      projects.push(project);
    }
  }

  return projects.sort((left, right) =>
    `${left.name}\0${left.stateDir}`.localeCompare(
      `${right.name}\0${right.stateDir}`,
      undefined,
      { sensitivity: "base" },
    ),
  );
};

export const findProjectByRepo = (
  projects: readonly ProjectRecord[],
  repoDir: string,
): ProjectRecord | undefined => {
  const resolvedRepoDir = resolveProjectRepository(repoDir);
  return projects.find(
    (project) =>
      project.repoDir !== undefined &&
      samePath(project.repoDir, resolvedRepoDir),
  );
};

export const projectManifestPath = (stateDir: string): string =>
  manifestPath(resolve(stateDir));
