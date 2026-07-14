#!/usr/bin/env node
// A small stdio MCP server for trying mcpmeter without wiring up a client.
// It plays a "docs assistant" with three tools of very different cost
// profiles — a fast search, a slow-and-chatty page fetch, and a summarizer
// that fails on empty input — so the metered report has something to say.
//
//   DEMO_BANNER=1  print a stray non-protocol line to stdout at startup,
//                  the classic bug that silently corrupts MCP streams.
import { createInterface } from "node:readline";

if (process.env.DEMO_BANNER === "1") {
  process.stdout.write("demo-server v1.0 ready\n"); // protocol junk, on purpose
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

const PAGES = {
  "getting-started": "Getting started\n".repeat(600),
  "api-reference": "API reference — every endpoint, exhaustively.\n".repeat(900),
  faq: "Q: Is it fast? A: Measure it.\n".repeat(300),
};

const TOOLS = [
  {
    name: "search_docs",
    description: "Search the documentation index",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "fetch_page",
    description: "Fetch a full documentation page by slug",
    inputSchema: { type: "object", properties: { slug: { type: "string" } } },
  },
  {
    name: "summarize",
    description: "Summarize a passage of text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];

function toolResult(id, text, isError = false) {
  reply(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
}

function handleToolCall(id, params, done) {
  const args = params?.arguments ?? {};
  switch (params?.name) {
    case "search_docs": {
      const query = String(args.query ?? "");
      const hits = Object.keys(PAGES).map((slug, i) => `${i + 1}. ${slug} (matches "${query}")`);
      setTimeout(() => {
        toolResult(id, hits.join("\n"));
        done();
      }, 8);
      return;
    }
    case "fetch_page": {
      const page = PAGES[args.slug];
      setTimeout(() => {
        if (page === undefined) toolResult(id, `no such page: ${args.slug}`, true);
        else toolResult(id, page);
        done();
      }, 35);
      return;
    }
    case "summarize": {
      const text = String(args.text ?? "");
      if (text.trim() === "") {
        toolResult(id, "cannot summarize empty text", true);
      } else {
        toolResult(id, `${text.slice(0, 60)}… (summary: ${text.length} chars in, 1 line out)`);
      }
      done();
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
      done();
  }
}

// Answer strictly in arrival order even when a handler is async, so runs
// are reproducible and the passthrough comparison in smoke.sh stays exact.
let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === undefined || id === undefined) return; // notification
  queue = queue.then(
    () =>
      new Promise((done) => {
        switch (method) {
          case "initialize":
            reply(id, {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "demo-docs-server", version: "1.0.0" },
            });
            done();
            break;
          case "tools/list":
            reply(id, { tools: TOOLS });
            done();
            break;
          case "tools/call":
            handleToolCall(id, params, done);
            break;
          case "ping":
            reply(id, {});
            done();
            break;
          default:
            send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
            done();
        }
      }),
  );
});
rl.on("close", () => {
  queue.then(() => process.exit(0));
});
