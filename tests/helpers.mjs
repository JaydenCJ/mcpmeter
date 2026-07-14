// Shared test plumbing: repo paths, a real-child-process CLI runner, a fake
// monotonic/wall clock, an array-sink meter factory, and JSON-RPC frame
// builders. Everything is deterministic — the clock only moves when a test
// tells it to.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MeterSession } from "../dist/index.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(ROOT, "dist", "cli.js");
export const FAKE_SERVER = join(ROOT, "tests", "fixtures", "fake-server.mjs");

/** Run the real CLI; never throws — returns { code, stdout, stderr }. */
export function runCli(args, options = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? ROOT,
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return { code: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A clock that only advances when the test calls tick(ms). */
export function fakeClock(startWallMs = 1_752_000_000_000) {
  let mono = 0;
  return {
    wallMs: () => startWallMs + mono,
    monoMs: () => mono,
    tick: (ms) => {
      mono += ms;
    },
  };
}

/** A MeterSession wired to an array sink and a fake clock, already started. */
export function meterWithSink(options = {}) {
  const events = [];
  const clock = options.clock ?? fakeClock();
  const meter = new MeterSession({
    sessionId: options.sessionId ?? "t1",
    command: options.command ?? ["node", "server.js"],
    ...(options.label !== undefined ? { label: options.label } : {}),
    clock,
    sink: (event) => events.push(event),
  });
  meter.start();
  return { meter, events, clock };
}

/** Serialized byte length of a frame the way the wire would carry it (line + \n). */
export function frameBytes(msg) {
  return Buffer.byteLength(`${JSON.stringify(msg)}\n`, "utf8");
}

export function request(id, method, params) {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

export function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function notification(method, params) {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
}

/** Feed a full round trip (request c2s, then response s2c) into a meter. */
export function roundTrip(meter, clock, msgReq, msgRes, latencyMs = 10) {
  meter.message("c2s", msgReq, frameBytes(msgReq));
  clock.tick(latencyMs);
  meter.message("s2c", msgRes, frameBytes(msgRes));
}

/** Collect FrameParser events from feeding it chunks (strings or buffers). */
export function parseChunks(parser, events, chunks, end = true) {
  for (const chunk of chunks) {
    parser.feed(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  if (end) parser.end();
  return events;
}

/** Events of a given type, in order. */
export function ofType(events, type) {
  return events.filter((event) => event.type === type);
}
