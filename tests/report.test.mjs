// Renderer units: the four output formats over one fixed report, humanized
// units, sorting/top-N options, CSV escaping, and the determinism guarantee
// (identical input → byte-identical output).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  aggregate,
  humanBytes,
  humanMs,
  render,
  renderCsv,
  renderJson,
  renderMarkdown,
  renderTable,
} from "../dist/index.js";

function fixtureReport() {
  const session = {
    file: "mem.jsonl",
    header: {
      type: "session",
      schema: 1,
      sessionId: "fix",
      command: ["node", "server.js"],
      startedAt: "2026-07-01T09:00:00.000Z",
      meterVersion: "0.1.0",
    },
    events: [
      mkCall("search_docs", 38, "ok", 412, 18000),
      mkCall("search_docs", 102, "ok", 380, 22000),
      mkCall("search_docs", 340, "tool_error", 401, 900),
      mkCall("fetch_page", 1200, "ok", 198, 45000),
      {
        type: "call",
        direction: "c2s",
        method: "initialize",
        id: 0,
        atMs: 0,
        latencyMs: 4,
        requestBytes: 250,
        responseBytes: 300,
        outcome: "ok",
      },
      { type: "junk", direction: "s2c", bytes: 34, atMs: 1 },
    ],
    end: { type: "end", endedAt: "2026-07-01T09:10:00.000Z", durationMs: 600000, exitCode: 0 },
    skippedLines: 0,
  };
  return aggregate([session]);
}

let idc = 10;
function mkCall(tool, latencyMs, outcome, requestBytes, responseBytes) {
  idc += 1;
  return {
    type: "call",
    direction: "c2s",
    method: "tools/call",
    tool,
    id: idc,
    atMs: idc,
    latencyMs,
    requestBytes,
    responseBytes,
    outcome,
  };
}

test("humanBytes and humanMs pick sensible units at each magnitude", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(1023), "1023 B");
  assert.equal(humanBytes(1024), "1.0 KiB");
  assert.equal(humanBytes(1536), "1.5 KiB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5.0 MiB");
  assert.equal(humanBytes(3 * 1024 * 1024 * 1024), "3.0 GiB");
  assert.equal(humanMs(0.4), "0ms");
  assert.equal(humanMs(38), "38ms");
  assert.equal(humanMs(999), "999ms");
  assert.equal(humanMs(1234), "1.23s");
  assert.equal(humanMs(90_000), "1.5m");
});

test("table output has overview, aligned tool rows and a methods section", () => {
  const out = renderTable(fixtureReport());
  assert.match(out, /1 session · 2026-07-01T09:00:00.000Z → 2026-07-01T09:00:00.000Z/);
  assert.match(out, /calls 5 · errors 1 \(20\.0%\)/);
  assert.match(out, /junk 1 frame \(34 B\)/); // singular — "1 frames" would be sloppy
  assert.match(out, /TOOL\s+CALLS\s+ERR\s+ERR%\s+P50\s+P90\s+P99\s+MAX/);
  assert.match(out, /METHOD/);
  assert.match(out, /initialize/);
  // sorted by calls: search_docs (3) before fetch_page (1)
  assert.ok(out.indexOf("search_docs") < out.indexOf("fetch_page"));
});

test("table columns stay aligned: every row of a section has equal width", () => {
  const out = renderTable(fixtureReport());
  const lines = out.split("\n").filter((line) => /^(TOOL|search_docs|fetch_page)/.test(line));
  const widths = new Set(lines.map((line) => line.length));
  assert.equal(widths.size, 1);
});

test("json output is parseable and matches the aggregate shape", () => {
  const parsed = JSON.parse(renderJson(fixtureReport()));
  assert.equal(parsed.overview.calls, 5);
  assert.equal(parsed.tools.length, 2);
  assert.equal(parsed.tools[0].name, "search_docs"); // sorted by calls
  assert.equal(parsed.tools[0].latency.p50, 102);
  assert.equal(parsed.methods[0].name, "initialize");
});

test("markdown output renders pipe tables with one row per tool", () => {
  const out = renderMarkdown(fixtureReport());
  assert.match(out, /^## mcpmeter report/);
  assert.match(out, /\| TOOL \| CALLS \|/);
  assert.match(out, /\| search_docs \| 3 \|/);
  assert.match(out, /\| METHOD \|/);
});

test("csv output has a stable header and one data row per tool and method", () => {
  const out = renderCsv(fixtureReport());
  const lines = out.trim().split("\n");
  assert.equal(lines[0].split(",")[0], "kind");
  assert.equal(lines.length, 1 + 2 + 1); // header + 2 tools + 1 method
  assert.match(lines[1], /^tool,search_docs,c2s,3,1,0\.3333,/);
  assert.match(lines[3], /^method,initialize,/);
});

test("csv escapes names containing commas and quotes", () => {
  const session = {
    file: "mem.jsonl",
    header: {
      type: "session",
      schema: 1,
      sessionId: "esc",
      command: [],
      startedAt: "2026-07-01T00:00:00.000Z",
      meterVersion: "0.1.0",
    },
    events: [mkCall('weird,"tool"', 5, "ok", 10, 10)],
    skippedLines: 0,
  };
  const out = renderCsv(aggregate([session]));
  assert.match(out, /"weird,""tool"""/);
});

test("render options: sort reorders rows and top trims them after sorting", () => {
  const sorted = renderTable(fixtureReport(), { sort: "p99" });
  assert.ok(sorted.indexOf("fetch_page") < sorted.indexOf("search_docs")); // slow first
  const trimmed = renderTable(fixtureReport(), { top: 1 });
  assert.match(trimmed, /search_docs/); // most calls survives the cut
  assert.doesNotMatch(trimmed, /fetch_page/);
});

test("an empty report renders 'no calls matched' instead of empty tables", () => {
  const empty = aggregate([]);
  assert.match(renderTable(empty), /no calls matched/);
  assert.match(renderMarkdown(empty), /_no calls matched_/);
});

test("rendering is deterministic: same report, byte-identical output", () => {
  const report = fixtureReport();
  for (const format of ["table", "json", "md", "csv"]) {
    assert.equal(render(format, report), render(format, report));
  }
});
