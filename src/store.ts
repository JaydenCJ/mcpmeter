/**
 * Session persistence: append-only JSONL files in a meter directory.
 *
 * One file per session, named `<sessionId>.jsonl`. Writes are line-atomic
 * appends so a crash mid-session loses at most the last line; the reader
 * tolerates missing footers (crashed sessions) and skips corrupt lines with
 * a count instead of failing, because a report over 200 sessions must not
 * die on one bad byte.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MeterEvent, SessionEndEvent, SessionStartEvent } from "./types.js";
import { isRecord } from "./types.js";

export const DEFAULT_METER_DIR = ".mcpmeter";

/** Keep session ids filesystem-safe; everything else becomes "-". */
export function sanitizeSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "session";
}

/** Default session id: sortable wall-clock stamp + pid for uniqueness. */
export function defaultSessionId(wallMs: number, pid: number): string {
  const stamp = new Date(wallMs).toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 20);
  return `s${stamp}-p${pid}`;
}

export function sessionFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sanitizeSessionId(sessionId)}.jsonl`);
}

/** Append-only event sink bound to one session file. */
export class SessionWriter {
  constructor(readonly filePath: string) {}

  write(event: MeterEvent): void {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export interface SessionData {
  file: string;
  header: SessionStartEvent;
  /** Everything between header and footer, in wire order. */
  events: MeterEvent[];
  /** Absent when the session crashed before writing its footer. */
  end?: SessionEndEvent;
  /** Lines that failed to parse (corruption); counted, never fatal. */
  skippedLines: number;
}

function isSessionHeader(value: unknown): value is SessionStartEvent {
  return (
    isRecord(value) &&
    value["type"] === "session" &&
    value["schema"] === 1 &&
    typeof value["sessionId"] === "string" &&
    typeof value["startedAt"] === "string"
  );
}

/** Read one session file. Returns null when the first line is not a valid header. */
export function readSessionFile(file: string): SessionData | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const firstLine = lines[0];
  if (firstLine === undefined) return null;
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (!isSessionHeader(header)) return null;

  const events: MeterEvent[] = [];
  let end: SessionEndEvent | undefined;
  let skippedLines = 0;
  for (const line of lines.slice(1)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecord(value) || typeof value["type"] !== "string") {
      skippedLines += 1;
      continue;
    }
    if (value["type"] === "end") {
      end = value as unknown as SessionEndEvent;
      continue;
    }
    events.push(value as unknown as MeterEvent);
  }
  return { file, header, events, ...(end !== undefined ? { end } : {}), skippedLines };
}

/** All `.jsonl` files in a meter directory, name-sorted for determinism. */
export function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));
}

export interface LoadResult {
  /** Valid sessions, ordered by startedAt (ties broken by file name). */
  sessions: SessionData[];
  /** Files that were not parseable session files at all. */
  skippedFiles: number;
}

export function loadSessions(dir: string): LoadResult {
  const sessions: SessionData[] = [];
  let skippedFiles = 0;
  for (const file of listSessionFiles(dir)) {
    const data = readSessionFile(file);
    if (data === null) {
      skippedFiles += 1;
    } else {
      sessions.push(data);
    }
  }
  sessions.sort((a, b) => {
    const at = a.header.startedAt;
    const bt = b.header.startedAt;
    if (at !== bt) return at < bt ? -1 : 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  return { sessions, skippedFiles };
}

/** Create the meter directory if needed and return it. */
export function ensureMeterDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
