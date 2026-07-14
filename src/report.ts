/**
 * Report renderers: the same aggregated `Report` in four shapes.
 *
 * `table` is for humans at a terminal, `md` drops into a PR description,
 * `json` and `csv` feed scripts and spreadsheets. All four are pure
 * string-producing functions over the aggregate — byte-identical output for
 * identical input, which smoke.sh asserts.
 */

import type { Report, Row, SortKey } from "./aggregate.js";
import { sortRows } from "./aggregate.js";

export type ReportFormat = "table" | "json" | "md" | "csv";

export const REPORT_FORMATS: readonly ReportFormat[] = ["table", "json", "md", "csv"];

export interface RenderOptions {
  sort?: SortKey;
  /** Keep only the first N rows of each section after sorting. */
  top?: number;
}

/** 1234567 → "1.2 MiB"; sub-KiB values stay exact. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/** 12.3 → "12ms", 1234 → "1.23s", 90000 → "1.5m". */
export function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** "1 call" / "3 calls" — every human-facing count goes through this. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function prepared(rows: readonly Row[], options: RenderOptions): Row[] {
  const sorted = sortRows(rows, options.sort ?? "calls");
  return options.top !== undefined && options.top >= 0 ? sorted.slice(0, options.top) : sorted;
}

/** s2c requests get an arrow so server-initiated traffic is unmistakable. */
function rowName(row: Row): string {
  return row.direction === "s2c" ? `← ${row.name}` : row.name;
}

const COLUMNS = ["CALLS", "ERR", "ERR%", "P50", "P90", "P99", "MAX", "REQ~", "RESP~", "TOTAL"] as const;

function rowCells(row: Row): string[] {
  return [
    String(row.calls),
    String(row.errors),
    pct(row.errorRate),
    humanMs(row.latency.p50),
    humanMs(row.latency.p90),
    humanMs(row.latency.p99),
    humanMs(row.latency.max),
    humanBytes(row.requestBytes.mean),
    humanBytes(row.responseBytes.mean),
    humanBytes(row.requestBytes.total + row.responseBytes.total),
  ];
}

function alignedTable(title: string, rows: readonly Row[]): string[] {
  const names = rows.map(rowName);
  const nameWidth = Math.max(title.length, ...names.map((n) => n.length));
  const cellRows = rows.map(rowCells);
  const widths = COLUMNS.map((column, i) =>
    Math.max(column.length, ...cellRows.map((cells) => (cells[i] ?? "").length)),
  );
  const lines: string[] = [];
  lines.push(
    [title.padEnd(nameWidth), ...COLUMNS.map((column, i) => column.padStart(widths[i] ?? 0))].join(
      "  ",
    ),
  );
  rows.forEach((row, r) => {
    const cells = cellRows[r] ?? [];
    lines.push(
      [
        (names[r] ?? "").padEnd(nameWidth),
        ...cells.map((cell, i) => cell.padStart(widths[i] ?? 0)),
      ].join("  "),
    );
  });
  return lines;
}

function overviewLines(report: Report): string[] {
  const o = report.overview;
  const span =
    o.firstStartedAt !== undefined && o.lastStartedAt !== undefined
      ? ` · ${o.firstStartedAt} → ${o.lastStartedAt}`
      : "";
  const lines = [
    `${plural(o.sessions, "session")}${span}`,
    `calls ${o.calls} · errors ${o.errors} (${pct(o.errorRate)}) · sent ${humanBytes(o.requestBytes)} · received ${humanBytes(o.responseBytes)}`,
  ];
  const oddities: string[] = [];
  if (o.cancelled > 0) oddities.push(`cancelled ${o.cancelled}`);
  if (o.unanswered > 0) oddities.push(`unanswered ${o.unanswered}`);
  if (o.junkFrames > 0) oddities.push(`junk ${plural(o.junkFrames, "frame")} (${humanBytes(o.junkBytes)})`);
  if (o.anomalies > 0) oddities.push(`protocol anomalies ${o.anomalies}`);
  if (o.skippedLines > 0) oddities.push(`corrupt lines skipped ${o.skippedLines}`);
  if (oddities.length > 0) lines.push(oddities.join(" · "));
  return lines;
}

export function renderTable(report: Report, options: RenderOptions = {}): string {
  const lines = overviewLines(report);
  const tools = prepared(report.tools, options);
  const methods = prepared(report.methods, options);
  if (tools.length > 0) {
    lines.push("", ...alignedTable("TOOL", tools));
  }
  if (methods.length > 0) {
    lines.push("", ...alignedTable("METHOD", methods));
  }
  if (tools.length === 0 && methods.length === 0) {
    lines.push("", "no calls matched");
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: Report, options: RenderOptions = {}): string {
  const shaped = {
    overview: report.overview,
    tools: prepared(report.tools, options),
    methods: prepared(report.methods, options),
  };
  return `${JSON.stringify(shaped, null, 2)}\n`;
}

function mdTable(title: string, rows: readonly Row[]): string[] {
  const lines = [
    `| ${title} | CALLS | ERR | ERR% | P50 | P90 | P99 | MAX | REQ~ | RESP~ | TOTAL |`,
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(`| ${escapeMd(rowName(row))} | ${rowCells(row).join(" | ")} |`);
  }
  return lines;
}

function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function renderMarkdown(report: Report, options: RenderOptions = {}): string {
  const lines = ["## mcpmeter report", ""];
  for (const line of overviewLines(report)) lines.push(`- ${line}`);
  const tools = prepared(report.tools, options);
  const methods = prepared(report.methods, options);
  if (tools.length > 0) lines.push("", ...mdTable("TOOL", tools));
  if (methods.length > 0) lines.push("", ...mdTable("METHOD", methods));
  if (tools.length === 0 && methods.length === 0) lines.push("", "_no calls matched_");
  return `${lines.join("\n")}\n`;
}

const CSV_HEADER = [
  "kind",
  "name",
  "direction",
  "calls",
  "errors",
  "error_rate",
  "cancelled",
  "unanswered",
  "p50_ms",
  "p90_ms",
  "p99_ms",
  "max_ms",
  "mean_ms",
  "req_bytes_mean",
  "req_bytes_max",
  "req_bytes_total",
  "resp_bytes_mean",
  "resp_bytes_max",
  "resp_bytes_total",
].join(",");

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(kind: "tool" | "method", row: Row): string {
  return [
    kind,
    csvField(row.name),
    row.direction,
    String(row.calls),
    String(row.errors),
    row.errorRate.toFixed(4),
    String(row.cancelled),
    String(row.unanswered),
    String(row.latency.p50),
    String(row.latency.p90),
    String(row.latency.p99),
    String(row.latency.max),
    String(row.latency.mean),
    String(row.requestBytes.mean),
    String(row.requestBytes.max),
    String(row.requestBytes.total),
    String(row.responseBytes.mean),
    String(row.responseBytes.max),
    String(row.responseBytes.total),
  ].join(",");
}

export function renderCsv(report: Report, options: RenderOptions = {}): string {
  const lines = [CSV_HEADER];
  for (const row of prepared(report.tools, options)) lines.push(csvRow("tool", row));
  for (const row of prepared(report.methods, options)) lines.push(csvRow("method", row));
  return `${lines.join("\n")}\n`;
}

export function render(format: ReportFormat, report: Report, options: RenderOptions = {}): string {
  switch (format) {
    case "table":
      return renderTable(report, options);
    case "json":
      return renderJson(report, options);
    case "md":
      return renderMarkdown(report, options);
    case "csv":
      return renderCsv(report, options);
  }
}
