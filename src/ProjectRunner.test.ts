import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spawnProjectRunner } from "./ProjectRunner.js";

describe("ProjectRunner", () => {
  it("spawns the generated entry with the repository cwd and forwards its exit code", async () => {
    let received:
      | {
          command: string;
          args: readonly string[];
          cwd: string | undefined;
          stdio: unknown;
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

    expect(received).toEqual({
      command:
        process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx",
      args:
        process.platform === "win32"
          ? [
              "/d",
              "/c",
              "npx.cmd",
              "tsx",
              "C:/cache/project/.sandcastle/main.mts",
            ]
          : ["tsx", "C:/cache/project/.sandcastle/main.mts"],
      cwd: "C:/projects/example",
      stdio: "inherit",
    });
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
});
