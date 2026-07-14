// End-to-end CLI tests against the compiled dist/cli.js in real child
// processes: the run→record→report pipeline with a real fake MCP server,
// byte-for-byte passthrough (including junk), exit-code propagation, the
// report/sessions subcommands, filters, and usage errors.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION } from "../dist/index.js";
import { FAKE_SERVER, ROOT, runCli } from "./helpers.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcpmeter-cli-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REQUESTS = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fail", arguments: {} } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom", arguments: {} } },
];
const INPUT = `${REQUESTS.map((m) => JSON.stringify(m)).join("\n")}\n`;

/** Run `mcpmeter run` around the fake server and return everything observable. */
function meterRun(dir, { sessionId = "t", extraArgs = [], input = INPUT, env = {} } = {}) {
  const out = runCli(
    ["run", "--dir", dir, "--session-id", sessionId, ...extraArgs, "--", "node", FAKE_SERVER],
    { input, env },
  );
  return { ...out, sessionFile: join(dir, `${sessionId}.jsonl`) };
}

test("--version prints the package version (and matches package.json)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const { code, stdout } = runCli(["--version"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), VERSION);
  assert.equal(VERSION, pkg.version);
});

test("--help documents every subcommand and exits 0; bare invocation exits 2", () => {
  const help = runCli(["--help"]);
  assert.equal(help.code, 0);
  for (const word of ["run", "report", "sessions", "--dir", "--format", "--tool"]) {
    assert.ok(help.stdout.includes(word), `help missing ${word}`);
  }
  assert.equal(runCli([]).code, 2);
});

test("unknown commands and unknown flags exit 2 with a pointer to --help", () => {
  const unknown = runCli(["frobnicate"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);
  const badFlag = runCli(["report", "--frobnicate"]);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.stderr, /unknown flag/);
  // flags are scoped per subcommand, exactly as --help documents them
  const wrongHome = runCli(["sessions", "--sort", "calls"]);
  assert.equal(wrongHome.code, 2);
  assert.match(wrongHome.stderr, /unknown flag for `mcpmeter sessions`: --sort/);
  assert.equal(runCli(["report", "--quiet"]).code, 2);
});

test("run passes the protocol through byte-for-byte and exits with the server's code", () => {
  withTempDir((dir) => {
    const metered = runCli(
      ["run", "--quiet", "--dir", dir, "--session-id", "a", "--", "node", FAKE_SERVER],
      { input: INPUT },
    );
    assert.equal(metered.code, 0);
    // stdout must be exactly what the fake server emits when run WITHOUT the proxy
    const bare = spawnSync("node", [FAKE_SERVER], { encoding: "utf8", input: INPUT });
    assert.equal(metered.stdout, bare.stdout);
  });
});

test("run records a session file with header, calls, junk-free footer", () => {
  withTempDir((dir) => {
    const { code, sessionFile } = meterRun(dir, { sessionId: "rec", extraArgs: ["--quiet"] });
    assert.equal(code, 0);
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "session");
    assert.equal(lines[0].sessionId, "rec");
    assert.deepEqual(lines[0].command, ["node", FAKE_SERVER]);
    const calls = lines.filter((l) => l.type === "call");
    assert.equal(calls.length, 5); // initialize, tools/list, echo, fail, boom
    const outcomes = calls.filter((l) => l.tool !== undefined).map((l) => [l.tool, l.outcome]);
    assert.deepEqual(outcomes, [
      ["echo", "ok"],
      ["fail", "tool_error"],
      ["boom", "rpc_error"],
    ]);
    assert.equal(lines[lines.length - 1].type, "end");
    assert.equal(lines[lines.length - 1].exitCode, 0);
  });
});

test("run forwards junk on stdout untouched AND records it", () => {
  withTempDir((dir) => {
    const { stdout, sessionFile } = meterRun(dir, {
      sessionId: "junky",
      extraArgs: ["--quiet"],
      env: { FAKE_BANNER: "1" },
    });
    assert.match(stdout, /^fake-server booting, please ignore\n/); // passthrough intact
    assert.match(stdout, /"jsonrpc":"2.0"/); // protocol still flows after the junk
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const junk = lines.filter((l) => l.type === "junk");
    assert.equal(junk.length, 1);
    assert.equal(junk[0].direction, "s2c");
    assert.equal(junk[0].bytes, Buffer.byteLength("fake-server booting, please ignore\n", "utf8"));
  });
});

test("run records unanswered requests when a tool never responds", () => {
  withTempDir((dir) => {
    const input = `${[
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "blackhole" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    ].join("\n")}\n`;
    const { sessionFile } = meterRun(dir, { sessionId: "hang", extraArgs: ["--quiet"], input });
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const unanswered = lines.filter((l) => l.type === "unanswered");
    assert.equal(unanswered.length, 1);
    assert.equal(unanswered[0].tool, "blackhole");
  });
});

test("run propagates a nonzero server exit code and records it in the footer", () => {
  withTempDir((dir) => {
    const { code, sessionFile } = meterRun(dir, {
      sessionId: "exit7",
      extraArgs: ["--quiet"],
      env: { FAKE_EXIT_CODE: "7" },
    });
    assert.equal(code, 7);
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[lines.length - 1].exitCode, 7);
  });
});

test("run exits 127 when the server command cannot be spawned", () => {
  withTempDir((dir) => {
    const out = runCli(["run", "--quiet", "--dir", dir, "--", "definitely-not-a-real-binary-xyz"], {
      input: "",
    });
    assert.equal(out.code, 127);
    assert.match(out.stderr, /failed to start server/);
  });
});

test("run without `--` or with an empty command is a usage error (exit 2)", () => {
  const noSplit = runCli(["run", "--dir", "x"]);
  assert.equal(noSplit.code, 2);
  assert.match(noSplit.stderr, /server command/);
  assert.equal(runCli(["run", "--dir", "x", "--"]).code, 2);
});

test("run prints an end-of-session summary on stderr unless --quiet", () => {
  withTempDir((dir) => {
    const loud = meterRun(dir, { sessionId: "loud" });
    assert.match(loud.stderr, /mcpmeter: 5 calls · 2 errors/);
    assert.match(loud.stderr, /mcpmeter report --dir/);
    const quiet = meterRun(dir, { sessionId: "shh", extraArgs: ["--quiet"] });
    assert.doesNotMatch(quiet.stderr, /mcpmeter:/);
  });
});

test("summary and sessions counts use singular forms at one (never '1 errors')", () => {
  withTempDir((dir) => {
    // exactly one call, one error, one tool — every count takes the singular path
    const input = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fail", arguments: {} },
    })}\n`;
    const { stderr } = meterRun(dir, { sessionId: "solo", input });
    assert.match(stderr, /mcpmeter: 1 call · 1 error · 0 unanswered · 1 tool · /);
    const { stdout } = runCli(["sessions", "--dir", dir]);
    assert.match(stdout, /solo  1 call  1 error  /);
  });
});

test("server stderr passes through to the user's stderr", () => {
  withTempDir((dir) => {
    const { stderr } = meterRun(dir, {
      sessionId: "logs",
      extraArgs: ["--quiet"],
      env: { FAKE_STDERR: "server log line, not protocol" },
    });
    assert.match(stderr, /server log line, not protocol/);
  });
});

test("report aggregates freshly recorded sessions into a per-tool table", () => {
  withTempDir((dir) => {
    meterRun(dir, { sessionId: "one", extraArgs: ["--quiet"] });
    meterRun(dir, { sessionId: "two", extraArgs: ["--quiet"] });
    const { code, stdout } = runCli(["report", "--dir", dir]);
    assert.equal(code, 0);
    assert.match(stdout, /2 sessions/);
    assert.match(stdout, /calls 10 · errors 4/);
    for (const name of ["echo", "fail", "boom", "initialize", "tools\\/list"]) {
      assert.match(stdout, new RegExp(name));
    }
  });
});

test("report --format json is machine-readable with correct per-tool counts", () => {
  withTempDir((dir) => {
    meterRun(dir, { sessionId: "j", extraArgs: ["--quiet"] });
    const { stdout } = runCli(["report", "--dir", dir, "--format", "json"]);
    const parsed = JSON.parse(stdout);
    const echo = parsed.tools.find((row) => row.name === "echo");
    assert.equal(echo.calls, 1);
    assert.equal(echo.errors, 0);
    assert.ok(echo.latency.p50 >= 0);
    assert.ok(echo.requestBytes.total > 0);
  });
});

test("report --tool filters to one tool; --label filters sessions", () => {
  withTempDir((dir) => {
    meterRun(dir, { sessionId: "lab1", extraArgs: ["--quiet", "--label", "v1"] });
    meterRun(dir, { sessionId: "lab2", extraArgs: ["--quiet", "--label", "v2"] });
    const byTool = runCli(["report", "--dir", dir, "--tool", "echo"]);
    assert.match(byTool.stdout, /echo/);
    assert.doesNotMatch(byTool.stdout, /boom/);
    const byLabel = runCli(["report", "--dir", dir, "--label", "v2", "--format", "json"]);
    assert.equal(JSON.parse(byLabel.stdout).overview.sessions, 1);
  });
});

test("report and sessions on an empty/missing dir exit 1 with a clear message", () => {
  withTempDir((dir) => {
    const out = runCli(["report", "--dir", join(dir, "empty")]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /no sessions found/);
    assert.equal(runCli(["sessions", "--dir", join(dir, "void")]).code, 1);
  });
});

test("report validates flag values: bad format, bad sort, bad --since exit 2", () => {
  assert.equal(runCli(["report", "--format", "xml"]).code, 2);
  assert.equal(runCli(["report", "--sort", "vibes"]).code, 2);
  assert.equal(runCli(["report", "--since", "not-a-time"]).code, 2);
  assert.equal(runCli(["report", "--top", "-3"]).code, 2);
});

test("report output is deterministic: same dir, byte-identical runs", () => {
  withTempDir((dir) => {
    meterRun(dir, { sessionId: "det", extraArgs: ["--quiet"] });
    const first = runCli(["report", "--dir", dir, "--format", "csv"]);
    const second = runCli(["report", "--dir", dir, "--format", "csv"]);
    assert.equal(first.stdout, second.stdout);
  });
});

test("sessions lists recorded sessions with counts; json shape is stable", () => {
  withTempDir((dir) => {
    meterRun(dir, { sessionId: "s1", extraArgs: ["--quiet", "--label", "nightly"] });
    const table = runCli(["sessions", "--dir", dir]);
    assert.equal(table.code, 0);
    assert.match(table.stdout, /s1 \[nightly\]  5 calls  2 errors/);
    const json = JSON.parse(runCli(["sessions", "--dir", dir, "--format", "json"]).stdout);
    assert.equal(json.length, 1);
    assert.equal(json[0].sessionId, "s1");
    assert.equal(json[0].exitCode, 0);
    assert.equal(json[0].calls, 5);
  });
});

