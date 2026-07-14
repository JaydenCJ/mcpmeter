#!/usr/bin/env node
// A deterministic fake MCP stdio server used by the CLI integration tests
// and scripts/smoke.sh. Reads newline-delimited JSON-RPC from stdin and
// answers synchronously, so runs are fast and order-stable. Behavior knobs
// come from the environment:
//   FAKE_BANNER=1      print a non-protocol banner line to stdout at start
//                      (a real bug class: stray prints corrupting the wire)
//   FAKE_EXIT_CODE=n   exit with code n when stdin closes (default 0)
//   FAKE_STDERR=text   write one line to stderr at start (log passthrough)
import { createInterface } from "node:readline";

if (process.env.FAKE_BANNER === "1") {
  process.stdout.write("fake-server booting, please ignore\n");
}
if (process.env.FAKE_STDERR) {
  process.stderr.write(`${process.env.FAKE_STDERR}\n`);
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const TOOLS = [
  { name: "echo", description: "returns its arguments" },
  { name: "fail", description: "always returns isError" },
  { name: "boom", description: "always returns a JSON-RPC error" },
  { name: "blackhole", description: "never responds" },
];

function handleToolCall(id, params) {
  const name = params?.name;
  if (name === "echo") {
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(params?.arguments ?? {}) }] },
    });
  } else if (name === "fail") {
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "tool failed: synthetic failure" }], isError: true },
    });
  } else if (name === "boom") {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal explosion" } });
  } else if (name === "blackhole") {
    // deliberately no response — the meter must report it as unanswered
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // a real server would choke; the fake shrugs so tests stay simple
  }
  const { id, method, params } = msg;
  if (method === undefined || id === undefined) return; // notifications: no reply
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-server", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      break;
    case "tools/call":
      handleToolCall(id, params);
      break;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
rl.on("close", () => {
  process.exit(Number(process.env.FAKE_EXIT_CODE ?? "0"));
});
