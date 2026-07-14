# Session file format

A recorded session is one JSONL file in the meter directory (default
`.mcpmeter/`), named `<sessionId>.jsonl`. Every line is a self-contained
JSON object with a `type` field. Lines are appended as traffic happens, so
a crash loses at most the final line; readers must tolerate a missing
footer and skip unparseable lines (the CLI counts them as
`corrupt lines skipped` in the report overview).

The schema below is **stable API** for the `schema: 1` generation. New
optional fields may be added in minor releases; renaming or removing a
field, or changing a field's meaning, requires bumping `schema`.

## Line types

| `type` | Cardinality | Meaning |
|---|---|---|
| `session` | exactly 1, first line | header: `sessionId`, optional `label`, `command` (argv of the metered server), `startedAt` (ISO 8601 UTC), `meterVersion`, `schema` |
| `call` | 0..n | one completed request/response pair (see below) |
| `notify` | 0..n | a JSON-RPC notification: `direction`, `method`, `bytes`, `atMs` |
| `junk` | 0..n | bytes on the protocol stream that were not a JSON-RPC frame: `direction`, `bytes`, `atMs` |
| `anomaly` | 0..n | protocol-shape violation: `kind` ∈ `orphan_response` \| `duplicate_id` \| `invalid_message` \| `batch_frame`, plus `direction`, `bytes`, `atMs`, optional `id` |
| `unanswered` | 0..n, at shutdown | a request that never got a response: `direction`, `method`, optional `tool`, `id`, `requestBytes`, `waitedMs` |
| `end` | exactly 1, last line | footer: `endedAt`, `durationMs`, `exitCode` (the server's; `null` when it died to a signal) |

## The `call` record

```json
{
  "type": "call",
  "direction": "c2s",
  "method": "tools/call",
  "tool": "search_docs",
  "id": 3,
  "atMs": 12.4,
  "latencyMs": 38.2,
  "requestBytes": 412,
  "responseBytes": 18043,
  "outcome": "ok"
}
```

- `direction` is the direction of the **request**: `c2s` for client-initiated
  calls, `s2c` for server-initiated ones (sampling, roots, elicitation).
- `tool` is present only for `tools/call` requests; a call whose `params.name`
  is missing or not a string is recorded as `"(unknown)"`.
- `atMs` is the monotonic offset from session start when the request was seen;
  `latencyMs` is request→response on the same monotonic clock, 0.1 ms
  resolution. Wall-clock jumps (NTP) cannot distort latencies.
- `requestBytes` / `responseBytes` are **wire bytes** of the whole frame,
  framing overhead included — this is what payload-size statistics aggregate.
- `outcome` is one of:

| Outcome | Trigger | Counted as error? |
|---|---|---|
| `ok` | plain `result` | no |
| `tool_error` | `result.isError === true` (MCP tool-level failure) | yes |
| `rpc_error` | JSON-RPC `error` member (`errorCode`, truncated `errorMessage` attached) | yes |
| `cancelled` | `notifications/cancelled` for a pending request (`latencyMs` = time until cancellation, `responseBytes` = 0) | no, and excluded from latency percentiles |

## Privacy posture

The recorder deliberately stores **metadata only**: method names, tool
names, byte counts, timings, outcomes, error codes and the first line of an
error message (truncated to 160 characters). Request arguments and result
payloads are never written to disk. Session files are safe to attach to an
issue in most settings, but error messages can still contain user text —
skim them before sharing.
