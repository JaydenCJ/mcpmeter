// Store units: JSONL write/read round trips, crashed-session tolerance
// (missing footer), corrupt-line counting, directory listing order, and
// session-id hygiene. All I/O happens in per-test temp dirs.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MeterSession,
  SessionWriter,
  defaultSessionId,
  listSessionFiles,
  loadSessions,
  readSessionFile,
  sanitizeSessionId,
  sessionFilePath,
} from "../dist/index.js";
import { fakeClock, frameBytes, request, response } from "./helpers.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcpmeter-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Record a full fake session to disk and return its file path. */
function writeSession(dir, sessionId, { label, startWallMs = 1_752_000_000_000 } = {}) {
  const clock = fakeClock(startWallMs);
  const file = sessionFilePath(dir, sessionId);
  const writer = new SessionWriter(file);
  const meter = new MeterSession({
    sessionId,
    command: ["node", "server.js"],
    ...(label !== undefined ? { label } : {}),
    clock,
    sink: (event) => writer.write(event),
  });
  meter.start();
  const req = request(1, "tools/call", { name: "echo", arguments: { text: "hi" } });
  meter.message("c2s", req, frameBytes(req));
  clock.tick(25);
  const res = response(1, { content: [{ type: "text", text: "hi" }] });
  meter.message("s2c", res, frameBytes(res));
  clock.tick(5);
  meter.end(0);
  return file;
}

test("a written session reads back: header, events in order, footer", () => {
  withTempDir((dir) => {
    const file = writeSession(dir, "roundtrip");
    const data = readSessionFile(file);
    assert.equal(data.header.sessionId, "roundtrip");
    assert.equal(data.header.meterVersion, "0.1.0");
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].type, "call");
    assert.equal(data.events[0].latencyMs, 25);
    assert.equal(data.end.exitCode, 0);
    assert.equal(data.end.durationMs, 30);
    assert.equal(data.skippedLines, 0);
  });
});

test("a session file without a footer (crash) still loads, end is absent", () => {
  withTempDir((dir) => {
    const file = join(dir, "crashed.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", schema: 1, sessionId: "crashed", command: [], startedAt: "2026-07-01T00:00:00.000Z", meterVersion: "0.1.0" })}\n` +
        `${JSON.stringify({ type: "junk", direction: "s2c", bytes: 9, atMs: 1 })}\n`,
      "utf8",
    );
    const data = readSessionFile(file);
    assert.equal(data.end, undefined);
    assert.equal(data.events.length, 1);
  });
});

test("corrupt lines are skipped and counted, never fatal", () => {
  withTempDir((dir) => {
    const file = writeSession(dir, "corrupt");
    const good = readSessionFile(file);
    writeFileSync(
      file,
      `${JSON.stringify(good.header)}\n{{{not json\n${JSON.stringify(good.events[0])}\n[1,2,3]\n`,
      "utf8",
    );
    const data = readSessionFile(file);
    assert.equal(data.events.length, 1);
    assert.equal(data.skippedLines, 2); // the garbage line and the array line
  });
});

test("a headerless file and a missing path both read as null, never a throw", () => {
  withTempDir((dir) => {
    const file = join(dir, "notasession.jsonl");
    writeFileSync(file, '{"type":"call","method":"x"}\n', "utf8");
    assert.equal(readSessionFile(file), null);
    assert.equal(readSessionFile(join(dir, "nope.jsonl")), null);
  });
});

test("listSessionFiles returns only .jsonl files, name-sorted; empty dir is []", () => {
  withTempDir((dir) => {
    assert.deepEqual(listSessionFiles(join(dir, "missing")), []);
    writeSession(dir, "bbb");
    writeSession(dir, "aaa");
    writeFileSync(join(dir, "notes.txt"), "ignore me", "utf8");
    const files = listSessionFiles(dir);
    assert.deepEqual(
      files.map((f) => f.split("/").pop()),
      ["aaa.jsonl", "bbb.jsonl"],
    );
  });
});

test("loadSessions orders by startedAt, not by file name", () => {
  withTempDir((dir) => {
    // "zzz" started FIRST despite sorting last by name
    writeSession(dir, "zzz", { startWallMs: 1_752_000_000_000 });
    writeSession(dir, "aaa", { startWallMs: 1_752_000_100_000 });
    const { sessions, skippedFiles } = loadSessions(dir);
    assert.deepEqual(
      sessions.map((s) => s.header.sessionId),
      ["zzz", "aaa"],
    );
    assert.equal(skippedFiles, 0);
  });
});

test("loadSessions counts unreadable session files instead of failing the report", () => {
  withTempDir((dir) => {
    writeSession(dir, "good");
    writeFileSync(join(dir, "bad.jsonl"), "complete garbage\n", "utf8");
    const { sessions, skippedFiles } = loadSessions(dir);
    assert.equal(sessions.length, 1);
    assert.equal(skippedFiles, 1);
  });
});

test("session ids are filesystem-safe by construction and time-sortable by default", () => {
  assert.equal(sanitizeSessionId("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeSessionId("my session #7"), "my-session-7");
  assert.equal(sanitizeSessionId(""), "session");
  assert.equal(sanitizeSessionId("ok-id_1.2"), "ok-id_1.2"); // already clean: untouched
  assert.ok(sanitizeSessionId("x".repeat(500)).length <= 120);
  const a = defaultSessionId(Date.parse("2026-07-01T10:00:00Z"), 100);
  const b = defaultSessionId(Date.parse("2026-07-02T10:00:00Z"), 100);
  assert.ok(a < b); // lexicographic order == chronological order
  assert.notEqual(defaultSessionId(0, 1), defaultSessionId(0, 2));
  assert.equal(sanitizeSessionId(a), a); // already filesystem-safe
});
