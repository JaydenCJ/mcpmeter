/**
 * Minimal ambient declarations for the handful of Node.js built-ins this
 * project uses. Declaring them in-repo keeps `typescript` the only
 * devDependency (no `@types/node`); the surface below is intentionally
 * restricted to exactly what `src/` calls, so a typo against a real Node
 * API still fails to compile.
 */

declare class Buffer extends Uint8Array {
  toString(encoding?: "utf8", start?: number, end?: number): string;
  indexOf(value: string | number | Uint8Array, byteOffset?: number): number;
  subarray(start?: number, end?: number): Buffer;
  static alloc(size: number): Buffer;
  static byteLength(str: string, encoding?: "utf8"): number;
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  static from(data: string | Uint8Array | readonly number[], encoding?: "utf8"): Buffer;
}

interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

interface WritableLike {
  write(chunk: Uint8Array | string): boolean;
  end(): void;
  on(event: "error", listener: (err: Error) => void): this;
  destroyed?: boolean;
}

declare module "node:fs" {
  export function appendFileSync(path: string, data: string, encoding: "utf8"): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options: { recursive: boolean }): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
}

declare module "node:path" {
  export function basename(path: string, suffix?: string): string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:child_process" {
  export interface ChildProcess {
    pid: number | undefined;
    stdin: WritableLike;
    stdout: ReadableLike;
    stderr: ReadableLike;
    kill(signal?: string): boolean;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { stdio: ["pipe", "pipe", "pipe"] },
  ): ChildProcess;
}

declare var process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  pid: number;
  hrtime: { bigint(): bigint };
  stdin: ReadableLike;
  stdout: WritableLike;
  stderr: WritableLike;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
