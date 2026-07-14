// Aggregation units: nearest-rank percentiles, per-tool/per-method grouping,
// error rates, byte statistics, unanswered handling, the session filters
// (last/since/label/tool), and row sorting. Sessions are built in memory —
// aggregation is pure, no disk involved.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { aggregate, filterSessions, percentile, sortRows } from "../dist/index.js";

let fileCounter = 0;

function makeSession({ sessionId, startedAt, label, events }) {
  fileCounter += 1;
  return {
    file: `mem-${fileCounter}.jsonl`,
    header: {
      type: "session",
      schema: 1,
      sessionId: sessionId ?? `s${fileCounter}`,
      ...(label !== undefined ? { label } : {}),
      command: ["node", "server.js"],
      startedAt: startedAt ?? "2026-07-01T00:00:00.000Z",
      meterVersion: "0.1.0",
    },
    events,
    end: { type: "end", endedAt: "2026-07-01T01:00:00.000Z", durationMs: 3_600_000, exitCode: 0 },
    skippedLines: 0,
  };
}

function call({
  tool,
  method,
  latencyMs = 10,
  outcome = "ok",
  requestBytes = 100,
  responseBytes = 200,
  direction = "c2s",
}) {
  return {
    type: "call",
    direction,
    method: method ?? (tool !== undefined ? "tools/call" : "ping"),
    ...(tool !== undefined ? { tool } : {}),
    id: 1,
    atMs: 0,
    latencyMs,
    requestBytes,
    responseBytes,
    outcome,
  };
}

test("percentile is nearest-rank: reported values actually happened", () => {
  const sample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sample, 50), 50); // rank ceil(0.5*10)=5 → 5th value
  assert.equal(percentile(sample, 90), 90);
  assert.equal(percentile(sample, 99), 100);
  assert.equal(percentile(sample, 100), 100);
  // edge cases: empty sample is 0, single sample is itself, two-sample split
  assert.equal(percentile([], 99), 0);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
  assert.equal(percentile([7, 13], 50), 7);
  assert.equal(percentile([7, 13], 99), 13);
});

test("calls group per tool with counts, latency stats and byte stats", () => {
  const session = makeSession({
    events: [
      call({ tool: "search", latencyMs: 10, requestBytes: 100, responseBytes: 1000 }),
      call({ tool: "search", latencyMs: 30, requestBytes: 300, responseBytes: 3000 }),
      call({ tool: "fetch", latencyMs: 500 }),
    ],
  });
  const report = aggregate([session]);
  assert.equal(report.tools.length, 2);
  const search = report.tools.find((row) => row.name === "search");
  assert.equal(search.calls, 2);
  assert.equal(search.latency.p50, 10);
  assert.equal(search.latency.max, 30);
  assert.equal(search.latency.mean, 20);
  assert.deepEqual(search.requestBytes, { total: 400, mean: 200, max: 300 });
  assert.deepEqual(search.responseBytes, { total: 4000, mean: 2000, max: 3000 });
});

test("non-tool methods land in the methods section, keyed by method name", () => {
  const session = makeSession({
    events: [
      call({ method: "initialize", latencyMs: 5 }),
      call({ method: "tools/list", latencyMs: 2 }),
      call({ tool: "echo" }),
    ],
  });
  const report = aggregate([session]);
  assert.deepEqual(report.methods.map((row) => row.name).sort(), ["initialize", "tools/list"]);
  assert.deepEqual(
    report.tools.map((row) => row.name),
    ["echo"],
  );
});

test("tool_error and rpc_error both count as errors; error rate is per row", () => {
  const session = makeSession({
    events: [
      call({ tool: "flaky", outcome: "ok" }),
      call({ tool: "flaky", outcome: "tool_error" }),
      call({ tool: "flaky", outcome: "rpc_error" }),
      call({ tool: "flaky", outcome: "ok" }),
      call({ tool: "solid", outcome: "ok" }),
    ],
  });
  const report = aggregate([session]);
  const flaky = report.tools.find((row) => row.name === "flaky");
  assert.equal(flaky.errors, 2);
  assert.equal(flaky.errorRate, 0.5);
  assert.equal(report.tools.find((row) => row.name === "solid").errorRate, 0);
  assert.equal(report.overview.errors, 2);
});

test("cancelled calls count separately and are excluded from latency percentiles", () => {
  const session = makeSession({
    events: [
      call({ tool: "job", latencyMs: 10 }),
      call({ tool: "job", latencyMs: 99999, outcome: "cancelled" }),
    ],
  });
  const row = aggregate([session]).tools[0];
  assert.equal(row.calls, 2);
  assert.equal(row.cancelled, 1);
  assert.equal(row.errors, 0); // a cancellation is not an error
  assert.equal(row.latency.max, 10); // the cancelled wait does not poison p99/max
});

test("unanswered requests count on their row and add request bytes only", () => {
  const session = makeSession({
    events: [
      call({ tool: "hang", latencyMs: 20, requestBytes: 100, responseBytes: 50 }),
      {
        type: "unanswered",
        direction: "c2s",
        method: "tools/call",
        tool: "hang",
        id: 2,
        requestBytes: 400,
        waitedMs: 5000,
      },
    ],
  });
  const report = aggregate([session]);
  const row = report.tools[0];
  assert.equal(row.calls, 1); // unanswered is NOT a completed call
  assert.equal(row.unanswered, 1);
  assert.equal(row.requestBytes.total, 500);
  assert.equal(row.responseBytes.total, 50);
  assert.equal(report.overview.unanswered, 1);
});

test("overview folds notifications, junk, anomalies and corrupt-line counts", () => {
  const session = makeSession({
    events: [
      call({ tool: "echo", requestBytes: 10, responseBytes: 20 }),
      { type: "notify", direction: "c2s", method: "notifications/initialized", bytes: 30, atMs: 0 },
      { type: "notify", direction: "s2c", method: "notifications/progress", bytes: 40, atMs: 1 },
      { type: "junk", direction: "s2c", bytes: 99, atMs: 2 },
      { type: "anomaly", kind: "orphan_response", direction: "s2c", bytes: 5, atMs: 3, id: 9 },
    ],
  });
  session.skippedLines = 3;
  const o = aggregate([session]).overview;
  assert.equal(o.calls, 1);
  assert.equal(o.notifications, 2);
  assert.equal(o.requestBytes, 10 + 30); // c2s notification counts as sent
  assert.equal(o.responseBytes, 20 + 40); // s2c notification counts as received
  assert.equal(o.junkFrames, 1);
  assert.equal(o.junkBytes, 99);
  assert.equal(o.anomalies, 1);
  assert.equal(o.skippedLines, 3);
});

test("aggregation spans sessions: same tool's calls merge across files", () => {
  const s1 = makeSession({
    startedAt: "2026-07-01T00:00:00.000Z",
    events: [call({ tool: "search", latencyMs: 10 })],
  });
  const s2 = makeSession({
    startedAt: "2026-07-02T00:00:00.000Z",
    events: [call({ tool: "search", latencyMs: 90 })],
  });
  const report = aggregate([s1, s2]);
  assert.equal(report.overview.sessions, 2);
  assert.equal(report.overview.firstStartedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(report.overview.lastStartedAt, "2026-07-02T00:00:00.000Z");
  const row = report.tools[0];
  assert.equal(row.calls, 2);
  assert.equal(row.latency.max, 90);
});

test("s2c rows keep their direction so reports can mark server-initiated traffic", () => {
  const session = makeSession({
    events: [call({ method: "sampling/createMessage", direction: "s2c", latencyMs: 300 })],
  });
  const row = aggregate([session]).methods[0];
  assert.equal(row.direction, "s2c");
});

test("filter lastN keeps only the most recent sessions by startedAt", () => {
  const sessions = [
    makeSession({ sessionId: "old", startedAt: "2026-07-01T00:00:00.000Z", events: [] }),
    makeSession({ sessionId: "mid", startedAt: "2026-07-02T00:00:00.000Z", events: [] }),
    makeSession({ sessionId: "new", startedAt: "2026-07-03T00:00:00.000Z", events: [] }),
  ];
  const picked = filterSessions(sessions, { lastN: 2 });
  assert.deepEqual(
    picked.map((s) => s.header.sessionId),
    ["mid", "new"],
  );
});

test("filter since keeps sessions started at or after the instant", () => {
  const sessions = [
    makeSession({ sessionId: "before", startedAt: "2026-06-30T23:59:59.000Z", events: [] }),
    makeSession({ sessionId: "exact", startedAt: "2026-07-01T00:00:00.000Z", events: [] }),
    makeSession({ sessionId: "after", startedAt: "2026-07-02T12:00:00.000Z", events: [] }),
  ];
  const picked = filterSessions(sessions, { since: "2026-07-01" });
  assert.deepEqual(
    picked.map((s) => s.header.sessionId),
    ["exact", "after"],
  );
});

test("filter label matches the session header label exactly", () => {
  const sessions = [
    makeSession({ sessionId: "a", label: "v1.2", events: [] }),
    makeSession({ sessionId: "b", label: "v1.3", events: [] }),
    makeSession({ sessionId: "c", events: [] }), // unlabelled never matches
  ];
  const picked = filterSessions(sessions, { label: "v1.3" });
  assert.deepEqual(
    picked.map((s) => s.header.sessionId),
    ["b"],
  );
});

test("filter tool narrows to one tool and hides the methods section", () => {
  const session = makeSession({
    events: [
      call({ tool: "search", latencyMs: 10 }),
      call({ tool: "fetch", latencyMs: 20 }),
      call({ method: "initialize" }),
      { type: "junk", direction: "s2c", bytes: 99, atMs: 0 },
    ],
  });
  const report = aggregate([session], { tool: "search" });
  assert.deepEqual(
    report.tools.map((row) => row.name),
    ["search"],
  );
  assert.deepEqual(report.methods, []);
  assert.equal(report.overview.calls, 1); // totals reflect the filtered scope
  assert.equal(report.overview.junkFrames, 0);
});

test("sortRows: numeric keys rank descending with alphabetical ties; name sorts a-z", () => {
  const rows = aggregate([
    makeSession({
      events: [
        call({ tool: "zeta" }),
        call({ tool: "alpha", latencyMs: 900, requestBytes: 10, responseBytes: 90000 }),
        call({ tool: "beta" }),
        call({ tool: "beta" }),
      ],
    }),
  ]).tools;
  assert.deepEqual(
    sortRows(rows, "calls").map((row) => row.name),
    ["beta", "alpha", "zeta"], // 2 calls first; the 1-call tie breaks a-z
  );
  assert.deepEqual(
    sortRows(rows, "name").map((row) => row.name),
    ["alpha", "beta", "zeta"],
  );
  assert.equal(sortRows(rows, "p99")[0].name, "alpha"); // the slow one
  assert.equal(sortRows(rows, "bytes")[0].name, "alpha"); // the heavy one
});

test("an empty session list aggregates to a zero report, no crash", () => {
  const report = aggregate([]);
  assert.equal(report.overview.sessions, 0);
  assert.equal(report.overview.errorRate, 0);
  assert.deepEqual(report.tools, []);
  assert.deepEqual(report.methods, []);
});
