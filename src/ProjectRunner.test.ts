import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  spawnProjectRunner,
  tsxCliPath,
  withSandcastleResolveHook,
} from "./ProjectRunner.js";

describe("ProjectRunner", () => {
  it("spawns node tsx with the repository cwd and forwards its exit code", async () => {
    let received:
      | {
          command: string;
          args: readonly string[];
          cwd: string | undefined;
          stdio: unknown;
          nodeOptions: string | undefined;
        }
      | undefined;

    const spawnProcess = (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      received = {
        command,
        args,
        cwd: options.cwd?.toString(),
        stdio: options.stdio,
        nodeOptions: (options.env as NodeJS.ProcessEnv | undefined)
          ?.NODE_OPTIONS,
      };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 23));
      return child as unknown as ChildProcess;
    };

    await expect(
      spawnProjectRunner(
        "C:/cache/project/.sandcastle/main.mts",
        "C:/projects/example",
        spawnProcess,
      ),
    ).resolves.toBe(23);

    expect(received?.command).toBe(process.execPath);
    expect(received?.args).toEqual([
      tsxCliPath(),
      "C:/cache/project/.sandcastle/main.mts",
    ]);
    expect(received?.cwd).toBe("C:/projects/example");
    expect(received?.stdio).toBe("inherit");
    expect(received?.nodeOptions).toContain("--import=");
    expect(received?.nodeOptions).toContain("register-sandcastle.js");
  });

  it("treats a child process without an exit code as a failed run", async () => {
    const spawnProcess = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", null));
      return child as unknown as ChildProcess;
    };

    await expect(
      spawnProjectRunner(
        "C:/cache/main.mts",
        "C:/projects/example",
        spawnProcess,
      ),
    ).resolves.toBe(1);
  });

  it("does not duplicate the resolve hook in NODE_OPTIONS", () => {
    const once = withSandcastleResolveHook({ NODE_OPTIONS: "" });
    const twice = withSandcastleResolveHook(once);
    const flag = "--import=";
    const matches = twice.NODE_OPTIONS?.match(/--import=/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(twice.NODE_OPTIONS).toContain(flag);
  });
});
