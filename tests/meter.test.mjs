// MeterSession units: request/response pairing, latency on a fake clock,
// outcome classification (ok / tool_error / rpc_error / cancelled), tool
// name extraction, both directions, and the protocol anomalies (orphans,
// duplicate ids, batches) that hand-rolled servers actually produce.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  errorResponse,
  fakeClock,
  frameBytes,
  meterWithSink,
  notification,
  ofType,
  request,
  response,
  roundTrip,
} from "./helpers.mjs";

test("session header is the first event and carries id, command and version", () => {
  const { events } = meterWithSink({ sessionId: "abc", command: ["node", "srv.js"], label: "v2" });
  assert.equal(events.length, 1);
  const header = events[0];
  assert.equal(header.type, "session");
  assert.equal(header.schema, 1);
  assert.equal(header.sessionId, "abc");
  assert.equal(header.label, "v2");
  assert.deepEqual(header.command, ["node", "srv.js"]);
  assert.match(header.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a request/response pair becomes one call with measured latency and wire bytes", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", request(1, "tools/list"), 999); // caller-supplied wire size wins
  clock.tick(37);
  meter.message("s2c", response(1, { tools: [] }), 111);
  const calls = ofType(events, "call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "tools/list");
  assert.equal(calls[0].latencyMs, 37);
  assert.equal(calls[0].outcome, "ok");
  assert.equal(calls[0].direction, "c2s");
  assert.equal(calls[0].requestBytes, 999); // from the wire, not re-serialized
  assert.equal(calls[0].responseBytes, 111);
});

test("tools/call extracts the tool name; other methods have no tool field", () => {
  const { meter, events, clock } = meterWithSink();
  roundTrip(meter, clock, request(1, "tools/call", { name: "search_docs", arguments: {} }), response(1, {}));
  roundTrip(meter, clock, request(2, "resources/read", { uri: "file:///a" }), response(2, {}));
  roundTrip(meter, clock, request(3, "tools/call", {}), response(3, {})); // nameless call
  const [toolCall, methodCall, nameless] = ofType(events, "call");
  assert.equal(toolCall.tool, "search_docs");
  assert.equal(methodCall.tool, undefined);
  assert.equal(nameless.tool, "(unknown)"); // still metered in the tools section
});

test("result.isError=true classifies as tool_error and captures the text", () => {
  const { meter, events, clock } = meterWithSink();
  roundTrip(
    meter,
    clock,
    request(1, "tools/call", { name: "fetch" }),
    response(1, { content: [{ type: "text", text: "timeout talking to backend\nstack..." }], isError: true }),
  );
  const call = ofType(events, "call")[0];
  assert.equal(call.outcome, "tool_error");
  assert.equal(call.errorMessage, "timeout talking to backend"); // first line only
});

test("a JSON-RPC error response classifies as rpc_error; long messages get truncated", () => {
  const { meter, events, clock } = meterWithSink();
  roundTrip(meter, clock, request(1, "tools/call", { name: "x" }), errorResponse(1, -32603, "kaput"));
  roundTrip(meter, clock, request(2, "x"), errorResponse(2, -1, "e".repeat(500)));
  const [call, longCall] = ofType(events, "call");
  assert.equal(call.outcome, "rpc_error");
  assert.equal(call.errorCode, -32603);
  assert.equal(call.errorMessage, "kaput");
  assert.ok(longCall.errorMessage.length <= 160); // never a payload dump
  assert.ok(longCall.errorMessage.endsWith("…"));
});

test("string id 1 and number id 1 are different in-flight requests", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", request(1, "alpha"), 10);
  meter.message("c2s", request("1", "beta"), 10);
  clock.tick(3);
  meter.message("s2c", response("1", {}), 10);
  meter.message("s2c", response(1, {}), 10);
  const calls = ofType(events, "call");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["beta", "alpha"], // answered in response order, no cross-talk
  );
  assert.equal(ofType(events, "anomaly").length, 0);
});

test("interleaved concurrent requests each get their own latency", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", request(1, "tools/call", { name: "slow" }), 10);
  clock.tick(10);
  meter.message("c2s", request(2, "tools/call", { name: "fast" }), 10);
  clock.tick(5);
  meter.message("s2c", response(2, {}), 10); // fast returns first
  clock.tick(85);
  meter.message("s2c", response(1, {}), 10);
  const byTool = Object.fromEntries(ofType(events, "call").map((c) => [c.tool, c.latencyMs]));
  assert.equal(byTool.fast, 5);
  assert.equal(byTool.slow, 100);
});

test("server-initiated requests (sampling) pair in the s2c direction", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("s2c", request(1, "sampling/createMessage", {}), 50);
  clock.tick(200);
  meter.message("c2s", response(1, { role: "assistant" }), 80);
  const call = ofType(events, "call")[0];
  assert.equal(call.direction, "s2c");
  assert.equal(call.method, "sampling/createMessage");
  assert.equal(call.latencyMs, 200);
});

test("same id used by both sides at once does not cross-pair", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", request(5, "tools/call", { name: "a" }), 10);
  meter.message("s2c", request(5, "roots/list"), 10); // server reuses id 5 — legal, separate space
  clock.tick(1);
  meter.message("c2s", response(5, {}), 10); // answers the SERVER's request
  meter.message("s2c", response(5, {}), 10); // answers the CLIENT's request
  const calls = ofType(events, "call");
  assert.equal(calls.length, 2);
  assert.equal(calls.find((c) => c.method === "roots/list").direction, "s2c");
  assert.equal(calls.find((c) => c.method === "tools/call").direction, "c2s");
  assert.equal(ofType(events, "anomaly").length, 0);
});

test("notifications are recorded with direction and bytes, never paired", () => {
  const { meter, events } = meterWithSink();
  const note = notification("notifications/progress", { progress: 0.5 });
  meter.message("c2s", note, frameBytes(note));
  const notes = ofType(events, "notify");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].method, "notifications/progress");
  assert.equal(notes[0].bytes, frameBytes(note));
});

test("notifications/cancelled resolves the pending call as cancelled", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", request(9, "tools/call", { name: "long_job" }), 40);
  clock.tick(150);
  meter.message("c2s", notification("notifications/cancelled", { requestId: 9 }), 30);
  const call = ofType(events, "call")[0];
  assert.equal(call.outcome, "cancelled");
  assert.equal(call.tool, "long_job");
  assert.equal(call.latencyMs, 150);
  assert.equal(call.responseBytes, 0);
  // and the session end has nothing left pending
  meter.end(0);
  assert.equal(ofType(events, "unanswered").length, 0);
});

test("a response with an id nobody asked is an orphan_response anomaly", () => {
  const { meter, events } = meterWithSink();
  meter.message("s2c", response(77, {}), 25);
  const anomalies = ofType(events, "anomaly");
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].kind, "orphan_response");
  assert.equal(anomalies[0].id, 77);
});

test("reusing an in-flight id is a duplicate_id anomaly; the newer request wins", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", request(3, "tools/call", { name: "first" }), 10);
  clock.tick(50);
  meter.message("c2s", request(3, "tools/call", { name: "second" }), 10);
  clock.tick(10);
  meter.message("s2c", response(3, {}), 10);
  assert.equal(ofType(events, "anomaly")[0].kind, "duplicate_id");
  const call = ofType(events, "call")[0];
  assert.equal(call.tool, "second");
  assert.equal(call.latencyMs, 10);
});

test("a frame that is neither request, response nor notification is invalid_message", () => {
  const { meter, events } = meterWithSink();
  meter.message("c2s", { jsonrpc: "2.0", id: 1 }, 20); // id but no method/result/error
  assert.equal(ofType(events, "anomaly")[0].kind, "invalid_message");
});

test("a batch array is flagged batch_frame but its elements still get metered", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", [request(1, "ping"), request(2, "ping")], 100);
  clock.tick(4);
  meter.message("s2c", response(1, {}), 10);
  meter.message("s2c", response(2, {}), 10);
  assert.equal(ofType(events, "anomaly")[0].kind, "batch_frame");
  assert.equal(ofType(events, "call").length, 2);
});

test("junk is recorded with direction, bytes and offset; zero-byte junk is dropped", () => {
  const { meter, events, clock } = meterWithSink();
  clock.tick(12);
  meter.junk("s2c", 57);
  meter.junk("s2c", 0);
  const junk = ofType(events, "junk");
  assert.equal(junk.length, 1);
  assert.deepEqual(junk[0], { type: "junk", direction: "s2c", bytes: 57, atMs: 12 });
});

test("end() reports every still-pending request as unanswered with its wait", () => {
  const { meter, events, clock } = meterWithSink();
  meter.message("c2s", request(1, "tools/call", { name: "blackhole" }), 60);
  clock.tick(500);
  meter.end(0);
  const unanswered = ofType(events, "unanswered");
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].tool, "blackhole");
  assert.equal(unanswered[0].waitedMs, 500);
  assert.equal(unanswered[0].requestBytes, 60);
});

test("end() writes the footer once (idempotent) and ignores frames after it", () => {
  const { meter, events, clock } = meterWithSink();
  clock.tick(1234);
  meter.end(3);
  meter.end(0); // second call must be a no-op
  meter.message("c2s", request(1, "ping"), 10); // late frames: dropped
  meter.junk("c2s", 5);
  const ends = ofType(events, "end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].durationMs, 1234);
  assert.equal(ends[0].exitCode, 3);
  assert.equal(events[events.length - 1].type, "end"); // nothing past the footer
});

test("null exit code (signal death) is preserved in the footer", () => {
  const { meter, events } = meterWithSink();
  meter.end(null);
  assert.equal(ofType(events, "end")[0].exitCode, null);
});

test("sub-millisecond latencies keep 0.1 ms resolution instead of rounding to 0", () => {
  const clock = fakeClock();
  const { meter, events } = meterWithSink({ clock });
  meter.message("c2s", request(1, "ping"), 10);
  clock.tick(0.25);
  meter.message("s2c", response(1, {}), 10);
  assert.equal(ofType(events, "call")[0].latencyMs, 0.3); // rounded to 0.1ms grid
});
