// Unit tests for the standard template's logging-layout helpers
// (src/templates/standard/logs.mts). The helpers are plain functions so the
// generated main.mts stays thin and the layout contract is testable.
//
// The test lives outside src/templates/ so it is never copied into
// scaffolded projects or dist/templates.

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  iterationPadWidth,
  localTimestamp,
  padStart,
  pointerLine,
  teeConsole,
  uniqueDirName,
} from "./templates/standard/logs.js";

describe("padStart", () => {
  it("pads a number to the requested width", () => {
    expect(padStart(1, 2)).toBe("01");
    expect(padStart(10, 2)).toBe("10");
    expect(padStart(7, 3)).toBe("007");
    expect(padStart(100, 3)).toBe("100");
  });
});

describe("localTimestamp", () => {
  it("formats local machine time as yyyyMMdd-HHmmss", () => {
    // Constructed with local getters, so the expected string holds in any
    // timezone — and fails for a toISOString() (UTC) implementation.
    const date = new Date(2026, 7, 13, 17, 52, 41); // 2026-08-13 17:52:41 local
    expect(localTimestamp(date)).toBe("20260813-175241");
  });

  it("never contains colons (safe in directory names)", () => {
    expect(localTimestamp(new Date())).not.toContain(":");
  });
});

describe("uniqueDirName", () => {
  it("returns the base name when it is free", () => {
    const dir = mkdtempSync(join(tmpdir(), "unique-dir-"));
    expect(uniqueDirName(dir, "01-20260813-175241")).toBe("01-20260813-175241");
  });

  it("suffixes -2, -3, ... when same-second names are taken", () => {
    const dir = mkdtempSync(join(tmpdir(), "unique-dir-"));
    mkdirSync(join(dir, "01-20260813-175241"));
    expect(uniqueDirName(dir, "01-20260813-175241")).toBe(
      "01-20260813-175241-2",
    );

    mkdirSync(join(dir, "loop"));
    mkdirSync(join(dir, "loop-2"));
    expect(uniqueDirName(dir, "loop")).toBe("loop-3");
  });
});

describe("iterationPadWidth", () => {
  it("uses the width of the max iteration count", () => {
    expect(iterationPadWidth(10)).toBe(2);
    expect(iterationPadWidth(100)).toBe(3);
    expect(iterationPadWidth(1)).toBe(1);
  });
});

describe("pointerLine", () => {
  it("records pad, status, taskId, and the loop directory", () => {
    expect(
      pointerLine(1, 2, "done", "sandcastle-i5u", "01-20260813-175241"),
    ).toBe("01 done sandcastle-i5u → 01-20260813-175241/");
  });

  it("omits the task id when the implementer did not report one", () => {
    expect(pointerLine(2, 2, "blocked", undefined, "02-20260813-175241")).toBe(
      "02 blocked → 02-20260813-175241/",
    );
  });
});

describe("teeConsole", () => {
  it("writes console output to the file while keeping the terminal sink", () => {
    const dir = mkdtempSync(join(tmpdir(), "tee-console-"));
    const logPath = join(dir, "main.log");

    const logCalls: unknown[][] = [];
    const errCalls: unknown[][] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      logCalls.push(args);
    };
    console.error = (...args: unknown[]) => {
      errCalls.push(args);
    };

    try {
      const restore = teeConsole(logPath);
      console.log("hello", 42);
      console.error("boom");
      console.log({ a: 1 });
      restore();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(logCalls).toEqual([["hello", 42], [{ a: 1 }]]);
    expect(errCalls).toEqual([["boom"]]);
    // util.format output: objects are inspected, not stringified as JSON.
    expect(readFileSync(logPath, "utf8")).toBe("hello 42\nboom\n{ a: 1 }\n");
  });

  it("creates missing parent directories for the log file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tee-console-"));
    const logPath = join(dir, "nested", "main.log");

    const originalLog = console.log;
    const originalError = console.error;
    try {
      const restore = teeConsole(logPath);
      console.log("line");
      restore();
      expect(readFileSync(logPath, "utf8")).toBe("line\n");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
