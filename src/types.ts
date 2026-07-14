/**
 * Shared wire and metric types.
 *
 * A recorded session is a JSONL file of `MeterEvent` lines: one `session`
 * header, any number of `call` / `notify` / `junk` / `anomaly` records,
 * `unanswered` records for requests still pending at shutdown, and one
 * `end` footer. The schema is documented in docs/session-format.md and is
 * stable API — reports from old sessions must keep aggregating.
 */

/** Who sent the frame: client→server or server→client. */
export type Direction = "c2s" | "s2c";

/** How a completed request/response pair ended. */
export type CallOutcome = "ok" | "tool_error" | "rpc_error" | "cancelled";

/** JSONL header line: exactly one per session file, always first. */
export interface SessionStartEvent {
  type: "session";
  /** Session-format schema version (bumped only on breaking changes). */
  schema: 1;
  sessionId: string;
  /** Optional user-supplied tag (e.g. a server version) for later filtering. */
  label?: string;
  /** The metered server command, argv-style. */
  command: string[];
  /** Wall-clock start, ISO 8601 UTC. */
  startedAt: string;
  meterVersion: string;
}

/** One completed request/response pair (the unit everything aggregates over). */
export interface CallEvent {
  type: "call";
  /** Direction of the REQUEST (`s2c` = server-initiated, e.g. sampling). */
  direction: Direction;
  method: string;
  /** Tool name, present only for `tools/call` requests. */
  tool?: string;
  id: string | number;
  /** Milliseconds since session start when the request was seen (monotonic). */
  atMs: number;
  latencyMs: number;
  /** Wire bytes of the request frame, framing included. */
  requestBytes: number;
  /** Wire bytes of the response frame, framing included (0 when cancelled). */
  responseBytes: number;
  outcome: CallOutcome;
  /** JSON-RPC error code, for `rpc_error` outcomes. */
  errorCode?: number;
  /** First line of the error text, truncated — enough to group by, never a payload dump. */
  errorMessage?: string;
}

/** A JSON-RPC notification (no id, so no latency — but bytes still count). */
export interface NotifyEvent {
  type: "notify";
  direction: Direction;
  method: string;
  bytes: number;
  atMs: number;
}

/** Bytes on the protocol stream that were not a JSON-RPC frame (stray prints, oversize frames). */
export interface JunkEvent {
  type: "junk";
  direction: Direction;
  bytes: number;
  atMs: number;
}

/** Protocol-shape violations worth counting but not worth crashing over. */
export interface AnomalyEvent {
  type: "anomaly";
  kind: "orphan_response" | "duplicate_id" | "invalid_message" | "batch_frame";
  direction: Direction;
  bytes: number;
  atMs: number;
  id?: string | number;
}

/** A request that never got a response before the session ended. */
export interface UnansweredEvent {
  type: "unanswered";
  direction: Direction;
  method: string;
  tool?: string;
  id: string | number;
  requestBytes: number;
  /** How long the request had been pending when the session ended. */
  waitedMs: number;
}

/** JSONL footer line: exactly one per cleanly-closed session file, always last. */
export interface SessionEndEvent {
  type: "end";
  endedAt: string;
  durationMs: number;
  /** The metered server's exit code; null when it died to a signal. */
  exitCode: number | null;
}

export type MeterEvent =
  | SessionStartEvent
  | CallEvent
  | NotifyEvent
  | JunkEvent
  | AnomalyEvent
  | UnansweredEvent
  | SessionEndEvent;

/** True for plain objects (what a JSON-RPC message must be). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
