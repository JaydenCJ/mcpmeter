/**
 * mcpmeter public API.
 *
 * The CLI is a thin shell over these exports; everything here is pure or
 * I/O-injectable so downstream tooling (and the test suite) can meter
 * frames, aggregate sessions, and render reports without spawning anything.
 */

export { DEFAULT_MAX_FRAME_BYTES, FrameParser } from "./framing.js";
export type { ParserEvent, ParserOptions } from "./framing.js";

export { MeterSession, systemClock, truncateErrorMessage } from "./meter.js";
export type { MeterClock, MeterSessionOptions } from "./meter.js";

export {
  DEFAULT_METER_DIR,
  SessionWriter,
  defaultSessionId,
  ensureMeterDir,
  listSessionFiles,
  loadSessions,
  readSessionFile,
  sanitizeSessionId,
  sessionFilePath,
} from "./store.js";
export type { LoadResult, SessionData } from "./store.js";

export { SORT_KEYS, aggregate, filterSessions, percentile, sortRows } from "./aggregate.js";
export type {
  AggregateFilters,
  ByteStats,
  LatencyStats,
  Overview,
  Report,
  Row,
  SortKey,
} from "./aggregate.js";

export {
  REPORT_FORMATS,
  humanBytes,
  humanMs,
  render,
  renderCsv,
  renderJson,
  renderMarkdown,
  renderTable,
} from "./report.js";
export type { RenderOptions, ReportFormat } from "./report.js";

export { runProxy } from "./proxy.js";
export type { RunOptions } from "./proxy.js";

export type {
  AnomalyEvent,
  CallEvent,
  CallOutcome,
  Direction,
  JunkEvent,
  MeterEvent,
  NotifyEvent,
  SessionEndEvent,
  SessionStartEvent,
  UnansweredEvent,
} from "./types.js";
export { isRecord } from "./types.js";

export { VERSION } from "./version.js";
