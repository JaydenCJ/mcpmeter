/**
 * The passthrough proxy: spawn the real MCP server, hand it our stdio
 * byte-for-byte, and meter a COPY of the traffic on the side.
 *
 * Invariants, in priority order:
 *   1. The wire is never altered, delayed or reordered — raw chunks are
 *      forwarded first, parsed second.
 *   2. The child's exit code (or signal) is propagated exactly.
 *   3. A metering failure must never take the session down; framing is
 *      already throw-free, and file appends failing would surface once via
 *      the spawn-time directory check rather than mid-session.
 */

import { spawn } from "node:child_process";
import { FrameParser } from "./framing.js";
import type { MeterClock } from "./meter.js";
import { MeterSession, systemClock } from "./meter.js";
import { SessionWriter, defaultSessionId, ensureMeterDir, sessionFilePath } from "./store.js";
import type { MeterEvent } from "./types.js";
import { humanBytes, humanMs, plural } from "./report.js";

export interface RunOptions {
  /** argv of the real server, e.g. ["node", "server.js", "--flag"]. */
  command: string[];
  /** Meter directory for the session file. Created if missing. */
  dir: string;
  sessionId?: string;
  label?: string;
  /** Suppress the end-of-session summary on stderr. */
  quiet?: boolean;
  maxFrameBytes?: number;
  clock?: MeterClock;
}

/** Signal → conventional 128+n exit code, for propagating a signalled child. */
const SIGNAL_EXIT: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGKILL: 137,
  SIGPIPE: 141,
  SIGTERM: 143,
};

interface Tally {
  calls: number;
  errors: number;
  unanswered: number;
  requestBytes: number;
  responseBytes: number;
  tools: Set<string>;
}

function tallyEvent(tally: Tally, event: MeterEvent): void {
  if (event.type === "call") {
    tally.calls += 1;
    if (event.outcome === "tool_error" || event.outcome === "rpc_error") tally.errors += 1;
    tally.requestBytes += event.requestBytes;
    tally.responseBytes += event.responseBytes;
    if (event.tool !== undefined) tally.tools.add(event.tool);
  } else if (event.type === "unanswered") {
    tally.unanswered += 1;
    tally.requestBytes += event.requestBytes;
  }
}

/**
 * Run the proxy. Resolves with the exit code the mcpmeter process should
 * exit with (the child's, or 127 when the command cannot be spawned).
 */
export function runProxy(options: RunOptions): Promise<number> {
  const clock = options.clock ?? systemClock;
  const dir = ensureMeterDir(options.dir);
  const sessionId = options.sessionId ?? defaultSessionId(clock.wallMs(), process.pid);
  const filePath = sessionFilePath(dir, sessionId);
  const writer = new SessionWriter(filePath);
  const tally: Tally = {
    calls: 0,
    errors: 0,
    unanswered: 0,
    requestBytes: 0,
    responseBytes: 0,
    tools: new Set(),
  };
  const meter = new MeterSession({
    sessionId,
    command: options.command,
    ...(options.label !== undefined ? { label: options.label } : {}),
    clock,
    sink: (event) => {
      writer.write(event);
      tallyEvent(tally, event);
    },
  });

  const [executable, ...args] = options.command;
  if (executable === undefined) return Promise.resolve(2);

  meter.start();
  const startedMono = clock.monoMs();

  return new Promise<number>((resolve) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const frameOptions =
      options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {};
    const c2s = new FrameParser(
      (e) =>
        e.kind === "message" ? meter.message("c2s", e.value, e.bytes) : meter.junk("c2s", e.bytes),
      frameOptions,
    );
    const s2c = new FrameParser(
      (e) =>
        e.kind === "message" ? meter.message("s2c", e.value, e.bytes) : meter.junk("s2c", e.bytes),
      frameOptions,
    );

    let settled = false;
    let stdoutDone = false;
    let exitResult: { code: number; recordedExit: number | null } | undefined;
    const finish = (code: number, recordedExit: number | null): void => {
      if (settled) return;
      settled = true;
      c2s.end();
      s2c.end();
      meter.end(recordedExit);
      if (!options.quiet) {
        const seconds = humanMs(clock.monoMs() - startedMono);
        process.stderr.write(
          `mcpmeter: ${plural(tally.calls, "call")} · ${plural(tally.errors, "error")} · ` +
            `${tally.unanswered} unanswered · ${plural(tally.tools.size, "tool")} · ` +
            `sent ${humanBytes(tally.requestBytes)} · received ${humanBytes(tally.responseBytes)} · ${seconds}\n`,
        );
        process.stderr.write(
          `mcpmeter: session "${sessionId}" → ${filePath} (view: mcpmeter report --dir ${dir})\n`,
        );
      }
      resolve(code);
    };

    child.on("error", (err) => {
      process.stderr.write(`mcpmeter: failed to start server: ${err.message}\n`);
      finish(127, null);
    });

    // Wire order matters: forward the raw chunk BEFORE feeding the parser,
    // so a pathological frame can never delay the real traffic.
    child.stdin.on("error", () => {
      /* server closed stdin early (EPIPE) — its right; keep metering stdout */
    });
    process.stdin.on("data", (chunk: Buffer) => {
      if (child.stdin.destroyed !== true) child.stdin.write(chunk);
      c2s.feed(chunk);
    });
    process.stdin.on("end", () => {
      if (child.stdin.destroyed !== true) child.stdin.end();
      c2s.end();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      s2c.feed(chunk);
    });
    // "exit" can fire while stdout still has buffered frames in flight;
    // finish only once both have happened so the tail of the stream is metered.
    child.stdout.on("end", () => {
      stdoutDone = true;
      if (exitResult !== undefined) finish(exitResult.code, exitResult.recordedExit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        child.kill(signal);
      });
    }

    child.on("exit", (code, signal) => {
      const exitCode = code ?? (signal !== null ? (SIGNAL_EXIT[signal] ?? 1) : 1);
      exitResult = { code: exitCode, recordedExit: code };
      if (stdoutDone) finish(exitCode, code);
    });
  });
}
