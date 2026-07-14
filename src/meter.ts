/**
 * The metering state machine — the part of mcpmeter that understands MCP.
 *
 * A `MeterSession` receives already-parsed frames from both directions,
 * pairs requests with their responses by JSON-RPC id, classifies outcomes
 * (`ok`, `tool_error` for `result.isError`, `rpc_error`, `cancelled` via
 * `notifications/cancelled`), measures latency on an injectable monotonic
 * clock, and emits `MeterEvent` records into a sink. It holds no I/O and no
 * globals, so tests drive it with a fake clock and an array sink.
 */

import type {
  CallOutcome,
  Direction,
  MeterEvent,
  SessionEndEvent,
  SessionStartEvent,
} from "./types.js";
import { isRecord } from "./types.js";
import { VERSION } from "./version.js";

export interface MeterClock {
  /** Wall-clock milliseconds since the epoch (session timestamps). */
  wallMs(): number;
  /** Monotonic milliseconds (latency measurement — never jumps with NTP). */
  monoMs(): number;
}

/** Real clock: wall from Date, monotonic from process.hrtime. */
export const systemClock: MeterClock = {
  wallMs: () => Date.now(),
  monoMs: () => Number(process.hrtime.bigint() / 1000n) / 1000,
};

export interface MeterSessionOptions {
  sessionId: string;
  /** The metered server command, recorded in the session header. */
  command: string[];
  /** Optional tag (server version, branch, machine) for report filtering. */
  label?: string;
  clock?: MeterClock;
  sink: (event: MeterEvent) => void;
}

interface PendingCall {
  direction: Direction;
  method: string;
  tool?: string;
  id: string | number;
  requestBytes: number;
  startedMono: number;
}

const ERROR_MESSAGE_LIMIT = 160;

/** Pending-map key: id type matters ("1" and 1 are different requests). */
function callKey(direction: Direction, id: string | number): string {
  return `${direction}:${typeof id}:${String(id)}`;
}

function opposite(direction: Direction): Direction {
  return direction === "c2s" ? "s2c" : "c2s";
}

/** First line of an error text, truncated — enough to group by in a report. */
export function truncateErrorMessage(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > ERROR_MESSAGE_LIMIT
    ? `${firstLine.slice(0, ERROR_MESSAGE_LIMIT - 1)}…`
    : firstLine;
}

export class MeterSession {
  private readonly pending = new Map<string, PendingCall>();
  private readonly clock: MeterClock;
  private readonly sink: (event: MeterEvent) => void;
  private readonly options: MeterSessionOptions;
  private startedMono = 0;
  private started = false;
  private ended = false;

  constructor(options: MeterSessionOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.sink = options.sink;
  }

  /** Emit the session header. Must be called before any frame. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedMono = this.clock.monoMs();
    const header: SessionStartEvent = {
      type: "session",
      schema: 1,
      sessionId: this.options.sessionId,
      ...(this.options.label !== undefined ? { label: this.options.label } : {}),
      command: this.options.command,
      startedAt: new Date(this.clock.wallMs()).toISOString(),
      meterVersion: VERSION,
    };
    this.sink(header);
  }

  /** A parsed frame from either direction. Arrays are treated as (illegal) batches. */
  message(direction: Direction, value: unknown, bytes: number): void {
    if (this.ended) return;
    if (Array.isArray(value)) {
      // JSON-RPC batches are forbidden by MCP since 2025-03-26; count the
      // violation, then still meter each element so the numbers stay honest.
      this.sink({ type: "anomaly", kind: "batch_frame", direction, bytes, atMs: this.at() });
      for (const element of value) {
        this.single(direction, element, Buffer.byteLength(JSON.stringify(element) ?? "", "utf8"));
      }
      return;
    }
    this.single(direction, value, bytes);
  }

  /** Non-frame bytes on the protocol stream (stray prints, oversize frames). */
  junk(direction: Direction, bytes: number): void {
    if (this.ended || bytes <= 0) return;
    this.sink({ type: "junk", direction, bytes, atMs: this.at() });
  }

  /** The stream is done: flush unanswered requests and the footer. Idempotent. */
  end(exitCode: number | null): void {
    if (this.ended) return;
    this.ended = true;
    const now = this.clock.monoMs();
    for (const call of this.pending.values()) {
      this.sink({
        type: "unanswered",
        direction: call.direction,
        method: call.method,
        ...(call.tool !== undefined ? { tool: call.tool } : {}),
        id: call.id,
        requestBytes: call.requestBytes,
        waitedMs: this.round(now - call.startedMono),
      });
    }
    this.pending.clear();
    const footer: SessionEndEvent = {
      type: "end",
      endedAt: new Date(this.clock.wallMs()).toISOString(),
      durationMs: this.round(now - this.startedMono),
      exitCode,
    };
    this.sink(footer);
  }

  private single(direction: Direction, msg: unknown, bytes: number): void {
    if (!isRecord(msg)) {
      this.sink({ type: "anomaly", kind: "invalid_message", direction, bytes, atMs: this.at() });
      return;
    }
    const id = msg["id"];
    const hasId = typeof id === "string" || typeof id === "number";
    const method = msg["method"];

    if (typeof method === "string") {
      if (hasId) {
        this.request(direction, method, id, msg, bytes);
      } else {
        this.notification(direction, method, msg, bytes);
      }
      return;
    }
    if (hasId && ("result" in msg || "error" in msg)) {
      this.response(direction, id, msg, bytes);
      return;
    }
    this.sink({ type: "anomaly", kind: "invalid_message", direction, bytes, atMs: this.at() });
  }

  private request(
    direction: Direction,
    method: string,
    id: string | number,
    msg: Record<string, unknown>,
    bytes: number,
  ): void {
    const key = callKey(direction, id);
    if (this.pending.has(key)) {
      // Reusing an in-flight id violates JSON-RPC; meter the newer request.
      this.sink({ type: "anomaly", kind: "duplicate_id", direction, bytes, atMs: this.at(), id });
    }
    let tool: string | undefined;
    if (method === "tools/call") {
      const params = msg["params"];
      tool = isRecord(params) && typeof params["name"] === "string" ? params["name"] : "(unknown)";
    }
    this.pending.set(key, {
      direction,
      method,
      ...(tool !== undefined ? { tool } : {}),
      id,
      requestBytes: bytes,
      startedMono: this.clock.monoMs(),
    });
  }

  private notification(
    direction: Direction,
    method: string,
    msg: Record<string, unknown>,
    bytes: number,
  ): void {
    if (method === "notifications/cancelled") {
      const params = msg["params"];
      const requestId = isRecord(params) ? params["requestId"] : undefined;
      if (typeof requestId === "string" || typeof requestId === "number") {
        // The cancelled request was issued BY the canceller's side.
        const key = callKey(direction, requestId);
        const call = this.pending.get(key);
        if (call) {
          this.pending.delete(key);
          this.emitCall(call, "cancelled", 0, {});
        }
      }
    }
    this.sink({ type: "notify", direction, method, bytes, atMs: this.at() });
  }

  private response(
    direction: Direction,
    id: string | number,
    msg: Record<string, unknown>,
    bytes: number,
  ): void {
    const key = callKey(opposite(direction), id);
    const call = this.pending.get(key);
    if (!call) {
      // A response nobody asked for — a real bug class in hand-rolled servers.
      this.sink({ type: "anomaly", kind: "orphan_response", direction, bytes, atMs: this.at(), id });
      return;
    }
    this.pending.delete(key);
    const error = msg["error"];
    if (isRecord(error)) {
      const code = typeof error["code"] === "number" ? error["code"] : undefined;
      const text = typeof error["message"] === "string" ? error["message"] : "";
      this.emitCall(call, "rpc_error", bytes, {
        ...(code !== undefined ? { errorCode: code } : {}),
        ...(text !== "" ? { errorMessage: truncateErrorMessage(text) } : {}),
      });
      return;
    }
    const result = msg["result"];
    if (isRecord(result) && result["isError"] === true) {
      this.emitCall(call, "tool_error", bytes, {
        ...(toolErrorText(result) !== undefined ? { errorMessage: toolErrorText(result) } : {}),
      });
      return;
    }
    this.emitCall(call, "ok", bytes, {});
  }

  private emitCall(
    call: PendingCall,
    outcome: CallOutcome,
    responseBytes: number,
    extra: { errorCode?: number; errorMessage?: string },
  ): void {
    this.sink({
      type: "call",
      direction: call.direction,
      method: call.method,
      ...(call.tool !== undefined ? { tool: call.tool } : {}),
      id: call.id,
      atMs: this.round(call.startedMono - this.startedMono),
      latencyMs: this.round(this.clock.monoMs() - call.startedMono),
      requestBytes: call.requestBytes,
      responseBytes,
      outcome,
      ...extra,
    });
  }

  /** Offset from session start, rounded to 0.1 ms so JSONL stays readable. */
  private at(): number {
    return this.round(this.clock.monoMs() - this.startedMono);
  }

  private round(ms: number): number {
    return Math.round(ms * 10) / 10;
  }
}

/** Text of the first text-content block of a failed tool result, truncated. */
function toolErrorText(result: Record<string, unknown>): string | undefined {
  const content = result["content"];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      return truncateErrorMessage(block["text"]);
    }
  }
  return undefined;
}
