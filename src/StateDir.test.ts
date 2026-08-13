import { describe, expect, it } from "vitest";
import {
  defaultCacheRoot,
  defaultStateDir,
  projectStateId,
  resolveCliStateDir,
  resolveInitStateDir,
  resolveRuntimeStateDir,
  STATE_DIR_NAME,
} from "./StateDir.js";
import { join } from "node:path";

describe("StateDir", () => {
  it("uses LOCALAPPDATA for the Windows cache root", () => {
    expect(
      defaultCacheRoot({
        platform: "win32",
        homeDir: "C:/Users/tester",
        localAppData: "C:/Users/tester/AppData/Local",
      }),
    ).toBe("C:/Users/tester/AppData/Local");
  });

  it("uses the standard cache roots on other platforms", () => {
    expect(
      defaultCacheRoot({
        platform: "darwin",
        homeDir: "/Users/tester",
      }),
    ).toBe(join("/Users/tester", "Library", "Caches"));

    expect(
      defaultCacheRoot({
        platform: "linux",
        homeDir: "/home/tester",
        xdgCacheHome: "/var/cache/tester",
      }),
    ).toBe("/var/cache/tester");
  });

  it("creates stable, collision-resistant project identifiers", () => {
    const first = projectStateId("C:/projects/example");
    const same = projectStateId("C:/projects/example");
    const other = projectStateId("C:/other/example");

    expect(first).toBe(same);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^example-[a-f0-9]{12}$/);
  });

  it("places the default state under the per-user project cache", () => {
    expect(
      defaultStateDir("C:/projects/example", {
        platform: "win32",
        localAppData: "C:/Users/tester/AppData/Local",
      }),
    ).toBe(
      join(
        "C:/Users/tester/AppData/Local",
        "Sandcastle",
        "projects",
        projectStateId("C:/projects/example"),
        STATE_DIR_NAME,
      ),
    );
  });

  it("uses the external cache for init and runtime", () => {
    const repoDir = "C:/projects/example";
    const explicit = "C:/tools/sandcastle/example";

    expect(resolveInitStateDir(repoDir, explicit)).toBe(
      join("C:/tools/sandcastle/example"),
    );
    expect(resolveRuntimeStateDir(repoDir)).toBe(defaultStateDir(repoDir));
  });

  it("does not fall back to a repository-local directory for CLI state", () => {
    const repoDir = process.cwd();

    expect(resolveCliStateDir(repoDir)).toBe(defaultStateDir(repoDir));
  });
});
