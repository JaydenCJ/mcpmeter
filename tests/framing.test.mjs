// FrameParser units: both stdio framings (NDJSON and Content-Length),
// chunk-boundary independence, junk accounting with exact byte counts, and
// the oversize-frame guards that keep a parse bomb from buffering forever.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FrameParser } from "../dist/index.js";
import { parseChunks } from "./helpers.mjs";

function collector() {
  const events = [];
  const parser = new FrameParser((event) => events.push(event));
  return { parser, events };
}

test("a single NDJSON frame parses with its exact wire byte count", () => {
  const { parser, events } = collector();
  const line = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
  parseChunks(parser, events, [line]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].bytes, Buffer.byteLength(line, "utf8"));
  assert.equal(events[0].value.method, "ping");
});

test("multiple frames in one chunk all come out in order; blank lines are not junk", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ['{"id":1,"method":"a"}\n\r\n\n{"id":2,"method":"b"}\n{"id":3,"method":"c"}\n']);
  assert.deepEqual(
    events.map((e) => e.value.method),
    ["a", "b", "c"],
  );
  assert.ok(events.every((e) => e.kind === "message"));
});

test("a frame split across arbitrary chunk boundaries still parses", () => {
  const { parser, events } = collector();
  const line = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"search"}}\n';
  // one-byte chunks: the cruellest boundary
  parseChunks(parser, events, [...line].map((ch) => ch));
  assert.equal(events.length, 1);
  assert.equal(events[0].value.id, 42);
  assert.equal(events[0].bytes, Buffer.byteLength(line, "utf8"));
});

test("multibyte UTF-8 split mid-character survives (bytes, not chars)", () => {
  const { parser, events } = collector();
  const line = `${JSON.stringify({ id: 1, method: "echo", params: { text: "日本語テスト" } })}\n`;
  const bytes = Buffer.from(line, "utf8");
  // split inside the second kanji's byte sequence
  parseChunks(parser, events, [bytes.subarray(0, 40), bytes.subarray(40)]);
  assert.equal(events.length, 1);
  assert.equal(events[0].value.params.text, "日本語テスト");
  assert.equal(events[0].bytes, bytes.length);
});

test("a non-JSON line is junk with its exact byte count (incl. newline)", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ["server booting on port 8080\n"]);
  assert.deepEqual(events, [{ kind: "junk", bytes: 28 }]);
});

test("junk between valid frames does not derail parsing", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ['{"id":1,"method":"a"}\nDEBUG: cache warm\n{"id":2,"method":"b"}\n']);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["message", "junk", "message"],
  );
});

test("a bare JSON scalar line is junk — JSON-RPC frames are objects", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ["42\n", '"hello"\n']);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["junk", "junk"],
  );
});

test("Content-Length framing parses, header bytes included in the count", () => {
  const { parser, events } = collector();
  const body = '{"jsonrpc":"2.0","id":7,"method":"initialize"}';
  const wire = `Content-Length: ${body.length}\r\n\r\n${body}`;
  parseChunks(parser, events, [wire]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].value.id, 7);
  assert.equal(events[0].bytes, Buffer.byteLength(wire, "utf8"));
});

test("Content-Length header is case-insensitive and tolerates bare-LF terminators", () => {
  const { parser, events } = collector();
  const body = '{"id":1,"method":"ping"}';
  parseChunks(parser, events, [`content-length: ${body.length}\n\n${body}`]);
  assert.equal(events.length, 1);
  assert.equal(events[0].value.method, "ping");
});

test("Content-Length body split across chunks waits for the full body", () => {
  const { parser, events } = collector();
  const body = '{"id":9,"method":"tools/list"}';
  const wire = `Content-Length: ${body.length}\r\n\r\n${body}`;
  parseChunks(parser, events, [wire.slice(0, 25), wire.slice(25, 40)], false);
  assert.equal(events.length, 0); // still incomplete
  parseChunks(parser, events, [wire.slice(40)]);
  assert.equal(events.length, 1);
  assert.equal(events[0].value.id, 9);
});

test("NDJSON and Content-Length frames can interleave on one stream", () => {
  const { parser, events } = collector();
  const clBody = '{"id":2,"method":"b"}';
  parseChunks(parser, events, [
    '{"id":1,"method":"a"}\n',
    `Content-Length: ${clBody.length}\r\n\r\n${clBody}`,
    '{"id":3,"method":"c"}\n',
  ]);
  assert.deepEqual(
    events.map((e) => e.value.method),
    ["a", "b", "c"],
  );
});

test("a Content-Length body that is not JSON counts as junk (header + body)", () => {
  const { parser, events } = collector();
  const wire = "Content-Length: 9\r\n\r\nnot json!";
  parseChunks(parser, events, [wire]);
  assert.deepEqual(events, [{ kind: "junk", bytes: Buffer.byteLength(wire, "utf8") }]);
});

test("an unparseable Content-Length value junks the header block; parsing recovers", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ['Content-Length: banana\r\n\r\n{"id":1,"method":"a"}\n']);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "junk");
  assert.equal(events[1].kind, "message"); // the frame after the bad header survives
});

test("an NDJSON line over maxFrameBytes becomes junk instead of buffering forever", () => {
  const { parser, events } = (() => {
    const evts = [];
    return { parser: new FrameParser((e) => evts.push(e), { maxFrameBytes: 64 }), events: evts };
  })();
  const huge = `{"id":1,"method":"x","params":{"blob":"${"A".repeat(200)}"}}\n`;
  parseChunks(parser, events, [huge, '{"id":2,"method":"after"}\n']);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "junk");
  assert.equal(events[0].bytes, Buffer.byteLength(huge, "utf8"));
  assert.equal(events[1].value.method, "after"); // parsing recovers at the newline
});

test("a Content-Length frame over maxFrameBytes is skipped without buffering the body", () => {
  const events = [];
  const parser = new FrameParser((e) => events.push(e), { maxFrameBytes: 32 });
  const body = "B".repeat(100);
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  parseChunks(parser, events, [header, body.slice(0, 50), body.slice(50), '{"id":5,"method":"ok"}\n']);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "junk");
  assert.equal(events[0].bytes, Buffer.byteLength(header, "utf8") + 100);
  assert.equal(events[1].value.method, "ok");
});

test("end() flushes a trailing frame with no final newline; end() is idempotent", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ['{"id":1,"method":"last"}']); // note: no \n, end() called
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].bytes, 24);
  parser.end(); // second end(): no double flush
  parser.feed(Buffer.from('{"id":2,"method":"late"}\n', "utf8")); // after end(): dropped
  assert.equal(events.length, 1);
});

test("end() flushes an incomplete Content-Length body as junk", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ["Content-Length: 50\r\n\r\n{\"id\":1"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "junk");
  assert.equal(events[0].bytes, Buffer.byteLength("Content-Length: 50\r\n\r\n", "utf8") + 7);
});

test("a short partial chunk that could be a header prefix waits instead of junking", () => {
  const { parser, events } = collector();
  parseChunks(parser, events, ["Content-Len"], false);
  assert.equal(events.length, 0); // inconclusive: neither message nor junk yet
  parseChunks(parser, events, ['gth: 24\r\n\r\n{"id":1,"method":"ping"}']);
  assert.equal(events.length, 1);
  assert.equal(events[0].value.method, "ping");
});
