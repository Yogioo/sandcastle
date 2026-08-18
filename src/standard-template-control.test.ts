// Unit tests for the standard template's file-based control plane
// (src/templates/standard/control/runtime.ts). Lives outside templates/
// so it is never copied into scaffolded projects.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listLoopDirs,
  resolveLogPath,
} from "./templates/standard/control/server.js";
import { createRuntime } from "./templates/standard/control/runtime.js";

describe("createRuntime", () => {
  it("writes state.json and drains append + commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-runtime-"));
    const runtime = createRuntime(dir, "run-test", {
      mainLog: join(dir, "main.log"),
    });

    expect(runtime.readState().runId).toBe("run-test");
    expect(runtime.readState().phase).toBe("idle");

    runtime.writeState({ phase: "implement", agent: "implementer", iteration: 1 });
    expect(runtime.readState().phase).toBe("implement");
    expect(runtime.readState().iteration).toBe(1);

    runtime.writeAppend("please also add tests");
    expect(runtime.takeAppend()).toContain("please also add tests");
    expect(runtime.takeAppend()).toBeNull();

    runtime.enqueueCommand({ type: "pause_agent" });
    runtime.enqueueCommand({ type: "resume_loop" });
    expect(runtime.takeCommands()).toEqual([
      { type: "pause_agent" },
      { type: "resume_loop" },
    ]);
    expect(runtime.takeCommands()).toEqual([]);

    runtime.appendEvent({ type: "sessionId", sessionId: "abc" });
    const events = readFileSync(runtime.paths.events, "utf-8");
    expect(events).toContain('"sessionId":"abc"');

    const stateOnDisk = JSON.parse(
      readFileSync(runtime.paths.state, "utf-8"),
    ) as { phase: string };
    expect(stateOnDisk.phase).toBe("implement");

    writeFileSync(runtime.paths.appendInbox, "  \n", "utf-8");
    expect(runtime.takeAppend()).toBeNull();
  });
});

describe("control server helpers", () => {
  it("lists loop directories and resolves log paths by cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-loops-"));
    const runDir = join(dir, "run-test");
    const loopOne = join(runDir, "01-20260818-170000");
    const loopTwo = join(runDir, "02-20260818-171000");
    mkdirSync(loopOne, { recursive: true });
    mkdirSync(loopTwo, { recursive: true });
    writeFileSync(join(runDir, "main.log"), "host\n");
    writeFileSync(join(loopOne, "implement.log"), "implement-1\n");
    writeFileSync(join(loopOne, "reviewer.log"), "review-1\n");
    writeFileSync(join(loopTwo, "implement.log"), "implement-2\n");

    expect(listLoopDirs(runDir)).toEqual([
      {
        name: "01-20260818-170000",
        iteration: 1,
        implementLog: join(loopOne, "implement.log"),
        reviewerLog: join(loopOne, "reviewer.log"),
      },
      {
        name: "02-20260818-171000",
        iteration: 2,
        implementLog: join(loopTwo, "implement.log"),
        reviewerLog: null,
      },
    ]);

    const state = {
      runId: "run-test",
      iteration: 2,
      phase: "implement" as const,
      agent: "implementer" as const,
      status: "running" as const,
      sessionId: null,
      taskId: null,
      loopDir: loopTwo,
      mainLog: join(runDir, "main.log"),
      implementLog: join(loopTwo, "implement.log"),
      reviewerLog: null,
      updatedAt: new Date().toISOString(),
    };

    expect(resolveLogPath(state, "main", null)).toBe(join(runDir, "main.log"));
    expect(resolveLogPath(state, "implement", null)).toBe(
      join(loopTwo, "implement.log"),
    );
    expect(resolveLogPath(state, "implement", "01-20260818-170000")).toBe(
      join(loopOne, "implement.log"),
    );
    expect(resolveLogPath(state, "reviewer", "01-20260818-170000")).toBe(
      join(loopOne, "reviewer.log"),
    );
  });
});
