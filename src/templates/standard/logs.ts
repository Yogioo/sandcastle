// Logging-layout helpers for the standard workflow — see AGENTS.md → Logs.
//
// Layout: one run directory per process, one loop subdirectory per
// implement→review cycle that actually starts. Nothing is ever deleted or
// rotated; pointer lines in main.log map task ids to loop directories.
//
//   logs/run-<yyyyMMdd-HHmmss>/
//     main.log
//     <pad(i)>-<yyyyMMdd-HHmmss>/
//       implement.log
//       reviewer.log            <- only when review runs
//
// Timestamps are local machine time (Date local getters) — never
// toISOString(), which is UTC and contains colons.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { format } from "node:util";

/** Zero-pad a number to the given width, e.g. padStart(1, 2) === "01". */
export const padStart = (value: number, width: number): string =>
  String(value).padStart(width, "0");

/** Local machine time as yyyyMMdd-HHmmss (safe in directory names). */
export const localTimestamp = (date: Date = new Date()): string =>
  `${date.getFullYear()}${padStart(date.getMonth() + 1, 2)}${padStart(
    date.getDate(),
    2,
  )}-${padStart(date.getHours(), 2)}${padStart(
    date.getMinutes(),
    2,
  )}${padStart(date.getSeconds(), 2)}`;

/**
 * A directory name under `parent` that does not exist yet. When a same-second
 * name is already taken, appends -2, -3, ... until a free name is found.
 */
export const uniqueDirName = (parent: string, base: string): string => {
  let name = base;
  for (let suffix = 2; existsSync(join(parent, name)); suffix += 1) {
    name = `${base}-${suffix}`;
  }
  return name;
};

/** Zero-pad width for loop numbers: String(maxIterations).length (10 → 2). */
export const iterationPadWidth = (maxIterations: number): number =>
  String(maxIterations).length;

/**
 * The pointer line main.log records after implement returns, e.g.
 * `01 done sandcastle-i5u → 01-20260813-175241/`. The task id is omitted
 * when the implementer did not report one.
 */
export const pointerLine = (
  iteration: number,
  width: number,
  status: string,
  taskId: string | undefined,
  loopDirName: string,
): string =>
  `${padStart(iteration, width)} ${status}${taskId ? ` ${taskId}` : ""} → ${loopDirName}/`;

/**
 * Tee console.log / console.error into `logPath` while keeping the current
 * terminal sinks. Call before the first run() so the `tail -f` startup hints
 * land in the file as well. Returns a restore function.
 */
export const teeConsole = (logPath: string): (() => void) => {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  mkdirSync(dirname(logPath), { recursive: true });
  const write = (sink: (...args: unknown[]) => void, args: unknown[]): void => {
    sink(...args);
    appendFileSync(logPath, `${format(...args)}\n`);
  };
  console.log = (...args: unknown[]): void => write(originalLog, args);
  console.error = (...args: unknown[]): void => write(originalError, args);
  return () => {
    console.log = originalLog;
    console.error = originalError;
  };
};
