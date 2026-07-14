#!/usr/bin/env node
/**
 * mcpmeter CLI — thin shell around the library.
 *
 * Exit codes are stable API:
 *   0  success (for `run`: the metered server exited 0)
 *   1  report/sessions found nothing to work with
 *   2  usage error (unknown command, bad flag, bad value)
 *   n  for `run`: the metered server's own exit code, propagated
 *  127 for `run`: the server command could not be spawned
 */

import type { AggregateFilters, SortKey } from "./aggregate.js";
import { SORT_KEYS, aggregate } from "./aggregate.js";
import { runProxy } from "./proxy.js";
import type { ReportFormat } from "./report.js";
import { REPORT_FORMATS, humanBytes, humanMs, plural, render } from "./report.js";
import { DEFAULT_METER_DIR, loadSessions } from "./store.js";
import { VERSION } from "./version.js";

const HELP = `mcpmeter ${VERSION} — usage meter for MCP stdio servers

Usage:
  mcpmeter run [options] -- <server command...>   proxy the server, record metrics
  mcpmeter report [options]                       aggregate recorded sessions
  mcpmeter sessions [options]                     list recorded sessions
  mcpmeter --version | --help

run options:
  --dir <path>          meter directory (default ${DEFAULT_METER_DIR})
  --session-id <id>     session file name (default: timestamp + pid)
  --label <text>        tag the session for later filtering (e.g. a server version)
  --max-frame <bytes>   frames larger than this count as junk (default 8388608)
  --quiet               no end-of-session summary on stderr

report options:
  --dir <path>          meter directory to read (default ${DEFAULT_METER_DIR})
  --format <f>          table | json | md | csv (default table)
  --sort <key>          calls | errors | p50 | p99 | max | bytes | name (default calls)
  --top <n>             keep only the first n rows per section
  --last <n>            only the n most recent sessions
  --since <time>        only sessions started at/after this ISO 8601 instant
  --label <text>        only sessions recorded with this label
  --tool <name>         only this tool's calls

sessions options:
  --dir <path>          meter directory to read (default ${DEFAULT_METER_DIR})
  --format <f>          table | json (default table)

The proxy is a byte-for-byte passthrough: add \`mcpmeter run --\` in front of
the server command in your MCP client's config and nothing else changes.
`;

class UsageError extends Error {}

interface Flags {
  values: Map<string, string>;
  booleans: Set<string>;
  positional: string[];
}

/** Per-subcommand flag sets — exactly what --help documents, nothing more. */
interface FlagSpec {
  command: string;
  value: ReadonlySet<string>;
  boolean?: ReadonlySet<string>;
}

const RUN_FLAGS: FlagSpec = {
  command: "run",
  value: new Set(["--dir", "--session-id", "--label", "--max-frame"]),
  boolean: new Set(["--quiet"]),
};
const REPORT_FLAGS: FlagSpec = {
  command: "report",
  value: new Set(["--dir", "--format", "--sort", "--top", "--last", "--since", "--label", "--tool"]),
};
const SESSIONS_FLAGS: FlagSpec = {
  command: "sessions",
  value: new Set(["--dir", "--format"]),
};

function parseFlags(argv: string[], spec: FlagSpec): Flags {
  const flags: Flags = { values: new Map(), booleans: new Set(), positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (spec.boolean?.has(arg) === true) {
      flags.booleans.add(arg);
    } else if (spec.value.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      flags.values.set(arg, value);
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag for \`mcpmeter ${spec.command}\`: ${arg}`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

function positiveInt(flags: Flags, name: string): number | undefined {
  const raw = flags.values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function oneOf<T extends string>(
  flags: Flags,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = flags.values.get(name);
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new UsageError(`${name} must be one of ${allowed.join("|")}, got: ${raw}`);
}

async function cmdRun(argv: string[]): Promise<number> {
  const split = argv.indexOf("--");
  if (split < 0) throw new UsageError("run needs `-- <server command...>`");
  const command = argv.slice(split + 1);
  if (command.length === 0) throw new UsageError("no server command after `--`");
  const flags = parseFlags(argv.slice(0, split), RUN_FLAGS);
  if (flags.positional.length > 0) {
    throw new UsageError(`unexpected argument: ${flags.positional[0]}`);
  }
  const sessionId = flags.values.get("--session-id");
  const label = flags.values.get("--label");
  const maxFrame = positiveInt(flags, "--max-frame");
  return runProxy({
    command,
    dir: flags.values.get("--dir") ?? DEFAULT_METER_DIR,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(maxFrame !== undefined ? { maxFrameBytes: maxFrame } : {}),
    quiet: flags.booleans.has("--quiet"),
  });
}

function cmdReport(argv: string[]): number {
  const flags = parseFlags(argv, REPORT_FLAGS);
  if (flags.positional.length > 0) {
    throw new UsageError(`unexpected argument: ${flags.positional[0]}`);
  }
  const dir = flags.values.get("--dir") ?? DEFAULT_METER_DIR;
  const format = oneOf<ReportFormat>(flags, "--format", REPORT_FORMATS, "table");
  const sort = oneOf<SortKey>(flags, "--sort", SORT_KEYS, "calls");
  const top = positiveInt(flags, "--top");
  const since = flags.values.get("--since");
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    throw new UsageError(`--since is not a parseable time: ${since}`);
  }
  const label = flags.values.get("--label");
  const tool = flags.values.get("--tool");
  const lastN = positiveInt(flags, "--last");
  const filters: AggregateFilters = {
    ...(lastN !== undefined ? { lastN } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(tool !== undefined ? { tool } : {}),
  };
  const { sessions, skippedFiles } = loadSessions(dir);
  if (sessions.length === 0) {
    process.stderr.write(`mcpmeter: no sessions found in ${dir}\n`);
    return 1;
  }
  if (skippedFiles > 0) {
    process.stderr.write(`mcpmeter: skipped ${skippedFiles} unreadable file(s) in ${dir}\n`);
  }
  const report = aggregate(sessions, filters);
  process.stdout.write(render(format, report, { sort, ...(top !== undefined ? { top } : {}) }));
  return 0;
}

function cmdSessions(argv: string[]): number {
  const flags = parseFlags(argv, SESSIONS_FLAGS);
  if (flags.positional.length > 0) {
    throw new UsageError(`unexpected argument: ${flags.positional[0]}`);
  }
  const dir = flags.values.get("--dir") ?? DEFAULT_METER_DIR;
  const format = oneOf(flags, "--format", ["table", "json"] as const, "table");
  const { sessions } = loadSessions(dir);
  if (sessions.length === 0) {
    process.stderr.write(`mcpmeter: no sessions found in ${dir}\n`);
    return 1;
  }
  const rows = sessions.map((session) => {
    let calls = 0;
    let errors = 0;
    let bytes = 0;
    for (const event of session.events) {
      if (event.type === "call") {
        calls += 1;
        if (event.outcome === "tool_error" || event.outcome === "rpc_error") errors += 1;
        bytes += event.requestBytes + event.responseBytes;
      }
    }
    return {
      sessionId: session.header.sessionId,
      startedAt: session.header.startedAt,
      ...(session.header.label !== undefined ? { label: session.header.label } : {}),
      durationMs: session.end?.durationMs ?? null,
      exitCode: session.end?.exitCode ?? null,
      calls,
      errors,
      bytes,
      file: session.file,
    };
  });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    const duration = row.durationMs !== null ? humanMs(row.durationMs) : "crashed?";
    const label = row.label !== undefined ? ` [${row.label}]` : "";
    process.stdout.write(
      `${row.startedAt}  ${row.sessionId}${label}  ${plural(row.calls, "call")}  ${plural(row.errors, "error")}  ` +
        `${humanBytes(row.bytes)}  ${duration}\n`,
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    process.stderr.write(HELP);
    return 2;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    switch (command) {
      case "run":
        return await cmdRun(rest);
      case "report":
        return cmdReport(rest);
      case "sessions":
        return cmdSessions(rest);
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`mcpmeter: ${err.message}\nRun \`mcpmeter --help\` for usage.\n`);
      return 2;
    }
    throw err;
  }
}

const code = await main(process.argv.slice(2));
if (process.argv[2] === "run") {
  // `run` must hard-exit: our stdin pipe may still be open and would keep
  // the process alive after the metered server is gone.
  process.exit(code);
}
// Everything else exits softly so piped stdout always flushes in full.
process.exitCode = code;
