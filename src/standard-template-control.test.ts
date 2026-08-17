// Unit tests for the standard template's file-based control plane
// (src/templates/standard/control/runtime.ts). Lives outside templates/
// so it is never copied into scaffolded projects.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
