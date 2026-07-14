# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- Passthrough stdio proxy (`mcpmeter run`): spawns the real MCP server,
  forwards stdin/stdout/stderr byte-for-byte, propagates the exit code
  (or 128+n for signals), and meters a copy of every chunk on the side —
  a metering failure can never alter the wire.
- Incremental frame parser for both stdio framings seen in the wild:
  newline-delimited JSON (MCP spec) and LSP-style `Content-Length` headers
  (case-insensitive, bare-LF tolerant), auto-detected per message, with
  chunk-boundary independence and an oversize-frame guard (default 8 MiB)
  that junks parse bombs instead of buffering them.
- MCP-aware metering: request/response pairing by id (per direction, id
  type respected), latency on a monotonic clock at 0.1 ms resolution,
  wire-byte accounting, and outcome classification — `ok`, `tool_error`
  (`result.isError`), `rpc_error` (code + truncated message), `cancelled`
  (via `notifications/cancelled`).
- Whole-session bookkeeping: notifications, junk bytes on the protocol
  stream, unanswered requests at shutdown, and protocol anomalies
  (orphan responses, duplicate ids, invalid messages, batch frames).
- Append-only JSONL session store (`.mcpmeter/*.jsonl`, metadata only,
  documented in `docs/session-format.md`) with a crash-tolerant reader
  that skips corrupt lines and missing footers, counting instead of dying.
- Cross-session aggregation (`mcpmeter report`): per-tool and per-method
  rows with call counts, error rates, nearest-rank p50/p90/p99/max/mean
  latency and mean/max/total payload bytes; filters `--last`, `--since`,
  `--label`, `--tool`; sort keys calls/errors/p50/p99/max/bytes/name;
  `--top` row capping.
- Four deterministic renderers: aligned terminal table, JSON, Markdown,
  CSV (with proper quoting).
- `mcpmeter sessions` listing with per-session call/error/byte counts.
- Session labels (`run --label`) for A/B-style comparisons across server
  versions, and safe session ids (`--session-id`, sanitized, time-sortable
  defaults).
- Programmatic API (`FrameParser`, `MeterSession`, store, `aggregate`,
  renderers, `runProxy`) with full type declarations; injectable clock and
  sinks throughout.
- Runnable examples: a three-tool demo MCP server, a realistic request
  script, and two deterministic pre-recorded sample sessions.
- Test suite: 91 node:test tests (framing, metering, store, aggregation,
  rendering, real child-process CLI runs) and an end-to-end
  `scripts/smoke.sh` that verifies byte-identical passthrough.

[0.1.0]: https://github.com/JaydenCJ/mcpmeter/releases/tag/v0.1.0
