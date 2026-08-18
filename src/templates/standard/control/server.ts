// Tiny 127.0.0.1 HTTP control + viz server (no framework).
//
//   GET  /           → viz/index.html
//   GET  /api/state  → state.json
//   GET  /api/events → events.jsonl (text)
//   GET  /api/log?name=main|implement|reviewer&loop=<dir> → log file tail
//   GET  /api/loops  → loop directories for this run (implement/review logs)
//   GET  /api/board  → bd list --all --json (issue board)
//   POST /api/command  { type: pause_agent|... }
//   POST /api/append   { text: "..." }  or raw body

import { execFile } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import type { ControlCommand, Runtime, RuntimeState } from "./runtime.js";

const execFileAsync = promisify(execFile);

export type BoardIssue = {
  id: string;
  title: string;
  status: string;
  priority: number | string | null;
  issue_type: string | null;
  assignee: string | null;
  labels: string[];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizeBoardIssue = (raw: unknown): BoardIssue | null => {
  const wrapped = asRecord(raw);
  const issue = asRecord(wrapped?.issue) ?? wrapped;
  if (!issue) return null;
  const id = issue.id ?? issue.number;
  const title = issue.title;
  if (typeof id !== "string" && typeof id !== "number") return null;
  if (typeof title !== "string") return null;
  const labelsRaw = issue.labels;
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw
        .map((label) =>
          typeof label === "string"
            ? label
            : typeof asRecord(label)?.name === "string"
              ? String(asRecord(label)!.name)
              : null,
        )
        .filter((label): label is string => label !== null)
    : [];
  return {
    id: String(id),
    title,
    status: typeof issue.status === "string" ? issue.status : "open",
    priority:
      typeof issue.priority === "number" || typeof issue.priority === "string"
        ? issue.priority
        : null,
    issue_type:
      typeof issue.issue_type === "string"
        ? issue.issue_type
        : typeof issue.type === "string"
          ? issue.type
          : null,
    assignee: typeof issue.assignee === "string" ? issue.assignee : null,
    labels,
  };
};

const parseBoardPayload = (
  stdout: string,
): { issues: BoardIssue[]; raw: string } => {
  const trimmed = stdout.trim();
  if (!trimmed) return { issues: [], raw: "" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(asRecord(parsed)?.items)
        ? (asRecord(parsed)!.items as unknown[])
        : Array.isArray(asRecord(parsed)?.issues)
          ? (asRecord(parsed)!.issues as unknown[])
          : null;
    if (!list) return { issues: [], raw: trimmed };
    return {
      issues: list
        .map(normalizeBoardIssue)
        .filter((issue): issue is BoardIssue => issue !== null),
      raw: trimmed,
    };
  } catch {
    return { issues: [], raw: trimmed };
  }
};

export type LoopInfo = {
  name: string;
  iteration: number | null;
  implementLog: string;
  reviewerLog: string | null;
};

const loopIteration = (name: string): number | null => {
  const match = /^(\d+)/.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
};

/** Loop subdirectories under a run dir (each holds implement.log). */
export const listLoopDirs = (runDir: string): LoopInfo[] => {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(runDir, entry.name);
      const implementLog = join(dir, "implement.log");
      if (!existsSync(implementLog)) return null;
      const reviewerLog = join(dir, "reviewer.log");
      return {
        name: entry.name,
        iteration: loopIteration(entry.name),
        implementLog,
        reviewerLog: existsSync(reviewerLog) ? reviewerLog : null,
      };
    })
    .filter((loop): loop is LoopInfo => loop !== null)
    .sort((a, b) => {
      if (a.iteration != null && b.iteration != null) {
        return a.iteration - b.iteration;
      }
      return a.name.localeCompare(b.name);
    });
};

export const resolveLogPath = (
  state: RuntimeState,
  name: string,
  loopName: string | null,
): string | null => {
  if (name === "main") return state.mainLog;
  const runDir = state.mainLog ? dirname(state.mainLog) : null;
  if (!runDir) return null;

  const loop =
    loopName ??
    (state.loopDir && state.loopDir.startsWith(runDir)
      ? basename(state.loopDir)
      : null);
  if (!loop) {
    return name === "implement"
      ? state.implementLog
      : name === "reviewer"
        ? state.reviewerLog
        : null;
  }

  const loopDir = join(runDir, loop);
  if (!existsSync(loopDir)) return null;
  if (name === "implement") return join(loopDir, "implement.log");
  if (name === "reviewer") return join(loopDir, "reviewer.log");
  return null;
};

const runBdList = async (
  cwd: string,
): Promise<{ ok: true; issues: BoardIssue[]; raw: string } | { ok: false; error: string }> => {
  try {
    // --all: bd list defaults to open-only; the board needs every status column.
    // shell:true so Windows resolves bd.cmd / bd.ps1 the same way the host terminal does.
    const { stdout } = await execFileAsync(
      "bd",
      ["list", "--all", "--json", "-n", "0"],
      {
      cwd,
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
      shell: true,
    });
    const parsed = parseBoardPayload(stdout);
    return { ok: true, ...parsed };
  } catch (error) {
    const message =
      error instanceof Error
        ? "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
          ? String((error as { stderr: string }).stderr).trim() || error.message
          : error.message
        : String(error);
    return { ok: false, error: message };
  }
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

const send = (
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void => {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
};

const sendJson = (res: ServerResponse, status: number, value: unknown): void =>
  send(res, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");

const tailFile = (path: string, maxBytes = 64_000): string => {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fdContent = readFileSync(path);
  return fdContent.subarray(start).toString("utf-8");
};

const serveStatic = (
  vizDir: string,
  urlPath: string,
  res: ServerResponse,
): void => {
  const rel =
    urlPath === "/" || urlPath === ""
      ? "index.html"
      : urlPath.replace(/^\//, "");
  const resolved = normalize(join(vizDir, rel));
  if (!resolved.startsWith(normalize(vizDir))) {
    send(res, 403, "forbidden");
    return;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    send(res, 404, "not found");
    return;
  }
  const type = MIME[extname(resolved)] ?? "application/octet-stream";
  send(res, 200, readFileSync(resolved, "utf-8"), type);
};

export type ControlServer = {
  readonly port: number;
  readonly url: string;
  close: () => Promise<void>;
};

export const startControlServer = (
  runtime: Runtime,
  opts?: { port?: number; host?: string; repoDir?: string },
): Promise<ControlServer> =>
  new Promise((resolve, reject) => {
    const host = opts?.host ?? "127.0.0.1";
    const preferredPort = opts?.port ?? 7421;
    const repoDir = opts?.repoDir ?? process.cwd();

    const handler = async (
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${host}`);

      try {
        if (method === "GET" && url.pathname === "/api/state") {
          sendJson(res, 200, runtime.readState());
          return;
        }
        if (method === "GET" && url.pathname === "/api/events") {
          send(
            res,
            200,
            existsSync(runtime.paths.events)
              ? readFileSync(runtime.paths.events, "utf-8")
              : "",
            "application/x-ndjson; charset=utf-8",
          );
          return;
        }
        if (method === "GET" && url.pathname === "/api/board") {
          const board = await runBdList(repoDir);
          if (!board.ok) {
            sendJson(res, 200, { ok: false, error: board.error, issues: [] });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            issues: board.issues,
            raw: board.raw,
          });
          return;
        }
        if (method === "GET" && url.pathname === "/api/loops") {
          const state = runtime.readState();
          const runDir = state.mainLog ? dirname(state.mainLog) : null;
          const loops = runDir ? listLoopDirs(runDir) : [];
          sendJson(res, 200, {
            loops,
            current: state.loopDir ? basename(state.loopDir) : null,
          });
          return;
        }
        if (method === "GET" && url.pathname === "/api/log") {
          const name = url.searchParams.get("name") ?? "main";
          const loop = url.searchParams.get("loop");
          const state = runtime.readState();
          const path = resolveLogPath(state, name, loop);
          if (!path) {
            send(res, 404, "log not available yet");
            return;
          }
          send(res, 200, tailFile(path), "text/plain; charset=utf-8");
          return;
        }
        if (method === "POST" && url.pathname === "/api/command") {
          const raw = await readBody(req);
          const parsed = JSON.parse(raw) as ControlCommand;
          if (
            parsed.type !== "pause_agent" &&
            parsed.type !== "resume_agent" &&
            parsed.type !== "pause_loop" &&
            parsed.type !== "resume_loop"
          ) {
            sendJson(res, 400, { error: "unknown command type" });
            return;
          }
          runtime.enqueueCommand(parsed);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (method === "POST" && url.pathname === "/api/append") {
          const raw = await readBody(req);
          let text = raw;
          try {
            const parsed = JSON.parse(raw) as { text?: string };
            if (typeof parsed.text === "string") text = parsed.text;
          } catch {
            // raw body is the append text
          }
          if (!text.trim()) {
            sendJson(res, 400, { error: "empty append" });
            return;
          }
          runtime.writeAppend(text);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (method === "GET") {
          serveStatic(runtime.vizDir, url.pathname, res);
          return;
        }
        send(res, 404, "not found");
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const server: Server = createServer((req, res) => {
      void handler(req, res);
    });

    const tryListen = (port: number, attemptsLeft: number): void => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("error", onError);
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryListen(port + 1, attemptsLeft - 1);
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        const address = server.address();
        const bound =
          address && typeof address === "object" ? address.port : port;
        resolve({
          port: bound,
          url: `http://${host}:${bound}/`,
          close: () =>
            new Promise((resClose, rejClose) => {
              server.close((e) => (e ? rejClose(e) : resClose()));
            }),
        });
      });
    };

    tryListen(preferredPort, 20);
  });
