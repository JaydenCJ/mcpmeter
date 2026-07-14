/**
 * Incremental stdio-frame parser for the metering side of the tap.
 *
 * The proxy passes raw bytes through untouched; a COPY of every chunk is fed
 * here. The parser understands both stdio framings seen in the wild —
 * newline-delimited JSON (the MCP spec) and LSP-style `Content-Length`
 * headers — auto-detected per message, and reports everything else as junk
 * with an exact byte count. It must never throw and never buffer without
 * bound: a single frame larger than `maxFrameBytes` is counted as junk and
 * skipped, because a parse bomb on the wire must not take the meter down.
 */

export type ParserEvent =
  | { kind: "message"; value: unknown; bytes: number }
  | { kind: "junk"; bytes: number };

export interface ParserOptions {
  /** Frames larger than this are counted as junk, not parsed. Default 8 MiB. */
  maxFrameBytes?: number;
}

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const HEADER_PREFIX = "content-length";
const NL = 10; // "\n"
const CR = 13; // "\r"

const EMPTY = Buffer.alloc(0);

type Mode = "scan" | "body" | "discard-body" | "discard-line";

export class FrameParser {
  private buf: Buffer = EMPTY;
  private mode: Mode = "scan";
  /** Bytes of the current frame's header block (Content-Length framing). */
  private headerBytes = 0;
  /** Expected body length while in "body" mode. */
  private bodyLength = 0;
  /** Bytes left to throw away while in "discard-body" mode. */
  private discardRemaining = 0;
  /** Bytes thrown away so far in either discard mode. */
  private discarded = 0;
  private ended = false;
  private readonly maxFrame: number;

  constructor(
    private readonly onEvent: (event: ParserEvent) => void,
    options: ParserOptions = {},
  ) {
    this.maxFrame = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Feed a copy of a raw stream chunk. Chunk boundaries carry no meaning. */
  feed(chunk: Uint8Array): void {
    if (this.ended || chunk.length === 0) return;
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  /** The stream closed: flush whatever is left (a trailing frame or junk). Idempotent. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.mode === "body") {
      // Incomplete Content-Length body: everything seen so far was wasted wire.
      this.emitJunk(this.headerBytes + this.buf.length);
    } else if (this.mode === "discard-body") {
      this.emitJunk(this.headerBytes + this.discarded);
    } else if (this.mode === "discard-line") {
      this.emitJunk(this.discarded + this.buf.length);
    } else {
      this.skipBlank();
      if (this.buf.length > 0) {
        // A final line with no trailing newline is still a frame.
        this.emitLine(this.buf.toString("utf8"), this.buf.length);
      }
    }
    this.buf = EMPTY;
  }

  private drain(): void {
    for (;;) {
      switch (this.mode) {
        case "discard-body": {
          const take = Math.min(this.buf.length, this.discardRemaining);
          this.buf = this.buf.subarray(take);
          this.discardRemaining -= take;
          this.discarded += take;
          if (this.discardRemaining > 0) return; // need more input
          this.emitJunk(this.headerBytes + this.discarded);
          this.mode = "scan";
          continue;
        }
        case "discard-line": {
          const nl = this.buf.indexOf(NL);
          if (nl < 0) {
            this.discarded += this.buf.length;
            this.buf = EMPTY;
            return;
          }
          this.emitJunk(this.discarded + nl + 1);
          this.buf = this.buf.subarray(nl + 1);
          this.discarded = 0;
          this.mode = "scan";
          continue;
        }
        case "body": {
          if (this.buf.length < this.bodyLength) return;
          const body = this.buf.subarray(0, this.bodyLength).toString("utf8");
          this.buf = this.buf.subarray(this.bodyLength);
          this.mode = "scan";
          this.emitLine(body, this.headerBytes + this.bodyLength);
          continue;
        }
        case "scan": {
          this.skipBlank();
          if (this.buf.length === 0) return;
          const headerish = this.looksLikeHeader();
          if (headerish === "maybe") return; // too short to tell; wait for more bytes
          if (headerish === "yes") {
            if (this.consumeHeader()) continue;
            // Header incomplete. A header block that never terminates is junk.
            if (this.buf.length > this.maxFrame) {
              this.discarded = this.buf.length;
              this.buf = EMPTY;
              this.mode = "discard-line";
            }
            return;
          }
          const nl = this.buf.indexOf(NL);
          if (nl < 0) {
            if (this.buf.length > this.maxFrame) {
              // An endless line: stop buffering, count it out as junk.
              this.discarded = this.buf.length;
              this.buf = EMPTY;
              this.mode = "discard-line";
              continue;
            }
            return;
          }
          if (nl + 1 > this.maxFrame) {
            // The line completed, but it is over the cap: junk by policy,
            // so one giant frame cannot distort the payload statistics.
            this.buf = this.buf.subarray(nl + 1);
            this.emitJunk(nl + 1);
            continue;
          }
          const line = this.buf.subarray(0, nl).toString("utf8");
          this.buf = this.buf.subarray(nl + 1);
          this.emitLine(line, nl + 1);
          continue;
        }
      }
    }
  }

  /** Drop leading CR/LF bytes — blank separator lines are not junk. */
  private skipBlank(): void {
    let i = 0;
    while (i < this.buf.length) {
      const b = this.buf[i];
      if (b !== NL && b !== CR) break;
      i += 1;
    }
    if (i > 0) this.buf = this.buf.subarray(i);
  }

  /** Does the buffer start with a Content-Length header? "maybe" = not enough bytes yet. */
  private looksLikeHeader(): "yes" | "no" | "maybe" {
    const probeLen = Math.min(this.buf.length, HEADER_PREFIX.length);
    const probe = this.buf.subarray(0, probeLen).toString("utf8").toLowerCase();
    if (probeLen < HEADER_PREFIX.length) {
      return HEADER_PREFIX.startsWith(probe) ? "maybe" : "no";
    }
    return probe === HEADER_PREFIX ? "yes" : "no";
  }

  /**
   * Try to consume a complete header block ("\r\n\r\n" or bare "\n\n"
   * terminated — both appear in real servers). Returns false if the
   * terminator has not arrived yet.
   */
  private consumeHeader(): boolean {
    const text = this.buf.toString("utf8");
    const crlf = text.indexOf("\r\n\r\n");
    const lf = text.indexOf("\n\n");
    let headerEnd: number;
    let terminatorLen: number;
    if (crlf >= 0 && (lf < 0 || crlf < lf)) {
      headerEnd = crlf;
      terminatorLen = 4;
    } else if (lf >= 0) {
      headerEnd = lf;
      terminatorLen = 2;
    } else {
      return false;
    }
    // Byte offsets equal char offsets here: headers are ASCII by construction
    // (we only get here when the buffer starts with "content-length").
    const blockBytes = Buffer.byteLength(text.slice(0, headerEnd), "utf8") + terminatorLen;
    const header = text.slice(0, headerEnd);
    let length = -1;
    for (const rawLine of header.split(/\r?\n/)) {
      const colon = rawLine.indexOf(":");
      if (colon < 0) continue;
      if (rawLine.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
      const parsed = Number(rawLine.slice(colon + 1).trim());
      if (Number.isInteger(parsed) && parsed >= 0) length = parsed;
    }
    this.buf = this.buf.subarray(blockBytes);
    if (length < 0) {
      // A Content-Length block whose value is unparseable: the header itself is junk.
      this.emitJunk(blockBytes);
      return true;
    }
    this.headerBytes = blockBytes;
    if (length > this.maxFrame) {
      this.mode = "discard-body";
      this.discardRemaining = length;
      this.discarded = 0;
    } else {
      this.mode = "body";
      this.bodyLength = length;
    }
    return true;
  }

  /** Parse one complete frame's text; anything that isn't a JSON object/array is junk. */
  private emitLine(text: string, bytes: number): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return; // whitespace-only frame body: ignore
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null) {
        this.onEvent({ kind: "message", value, bytes });
      } else {
        this.onEvent({ kind: "junk", bytes }); // a bare JSON scalar is not a JSON-RPC frame
      }
    } catch {
      this.onEvent({ kind: "junk", bytes });
    }
  }

  private emitJunk(bytes: number): void {
    if (bytes > 0) this.onEvent({ kind: "junk", bytes });
  }
}
