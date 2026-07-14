#!/usr/bin/env bash
# Smoke test for mcpmeter: exercises the real CLI end to end — meter a live
# demo server through the passthrough proxy, then aggregate the recordings
# in every output format. No network, idempotent, runs from a clean checkout
# (after `npm install`). Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
METER_DIR="$WORKDIR/meter"

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents every subcommand.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in run report sessions --tool --label --sort; do
  echo "$HELP" | grep -q -- "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Exit codes: unknown commands/flags exit 2, empty meter dir exits 1.
set +e
$CLI frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI report --frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown flag should exit 2"; }
$CLI report --dir "$WORKDIR/empty" >/dev/null 2>&1; [ $? -eq 1 ] || { set -e; fail "empty dir should exit 1"; }
set -e
echo "[smoke] exit codes ok (2 usage, 1 nothing to report)"

# 4. run: meter the bundled demo server; protocol must reach stdout intact
#    and a session file must appear with calls and a footer.
$CLI run --dir "$METER_DIR" --session-id smoke-a --label demo -- node examples/demo-server.mjs \
  < examples/requests.ndjson > "$WORKDIR/out-a.ndjson" 2> "$WORKDIR/err-a.txt" \
  || fail "run (session a) exited nonzero"
grep -q '"serverInfo"' "$WORKDIR/out-a.ndjson" || fail "initialize response missing from stdout"
grep -q '"isError":true' "$WORKDIR/out-a.ndjson" || fail "tool error response missing from stdout"
[ -f "$METER_DIR/smoke-a.jsonl" ] || fail "session file not written"
grep -q '"type":"session"' "$METER_DIR/smoke-a.jsonl" || fail "session header missing"
grep -q '"tool":"fetch_page"' "$METER_DIR/smoke-a.jsonl" || fail "tool call not recorded"
grep -q '"type":"end"' "$METER_DIR/smoke-a.jsonl" || fail "session footer missing"
grep -q "mcpmeter: session \"smoke-a\"" "$WORKDIR/err-a.txt" || fail "summary missing from stderr"
echo "[smoke] run ok (session recorded, protocol passed through)"

# 5. Passthrough fidelity: metered stdout == the server run bare, byte for byte —
#    including a deliberate junk banner, which must also land in the metrics.
DEMO_BANNER=1 node examples/demo-server.mjs < examples/requests.ndjson > "$WORKDIR/bare-banner.ndjson"
DEMO_BANNER=1 $CLI run --quiet --dir "$METER_DIR" --session-id smoke-b -- node examples/demo-server.mjs \
  < examples/requests.ndjson > "$WORKDIR/out-b.ndjson" || fail "run (session b) exited nonzero"
cmp -s "$WORKDIR/out-b.ndjson" "$WORKDIR/bare-banner.ndjson" || fail "passthrough altered the byte stream"
grep -q '"type":"junk"' "$METER_DIR/smoke-b.jsonl" || fail "stdout junk banner not metered"
echo "[smoke] passthrough ok (byte-identical, junk metered)"

# 6. report: aggregate the two fresh sessions; both tools and totals show up.
REPORT="$($CLI report --dir "$METER_DIR")"
echo "$REPORT" | grep -q "2 sessions" || fail "report should span 2 sessions"
echo "$REPORT" | grep -q "search_docs" || fail "report missing search_docs row"
echo "$REPORT" | grep -q "summarize" || fail "report missing summarize row"
echo "$REPORT" | grep -q "initialize" || fail "report missing methods section"
echo "[smoke] report ok (2 sessions aggregated)"

# 7. Every output format renders; json parses with the right shape.
$CLI report --dir "$METER_DIR" --format json > "$WORKDIR/report.json"
node -e "
  const r = JSON.parse(require('node:fs').readFileSync('$WORKDIR/report.json','utf8'));
  if (r.overview.sessions !== 2) throw new Error('sessions != 2');
  if (!Array.isArray(r.tools) || r.tools.length < 3) throw new Error('tool rows missing');
  const s = r.tools.find((t) => t.name === 'summarize');
  if (!s || s.errors < 1) throw new Error('summarize isError not counted');
" || fail "json report shape wrong"
$CLI report --dir "$METER_DIR" --format md | grep -q '| TOOL |' || fail "md table missing"
$CLI report --dir "$METER_DIR" --format csv | head -1 | grep -q '^kind,name,direction' || fail "csv header wrong"
echo "[smoke] formats ok (table/json/md/csv)"

# 8. Filters and sorting: --tool narrows, --label selects, --sort p99 reorders.
$CLI report --dir "$METER_DIR" --tool fetch_page | grep -q "fetch_page" || fail "--tool row missing"
$CLI report --dir "$METER_DIR" --tool fetch_page | grep -q "search_docs" && fail "--tool did not filter"
LABELLED="$($CLI report --dir "$METER_DIR" --label demo --format json)"
echo "$LABELLED" | grep -q '"sessions": 1' || fail "--label should match only session a"
$CLI report --dir "$METER_DIR" --sort bytes --top 1 | grep -q "fetch_page" || fail "--sort bytes should rank fetch_page first"
echo "[smoke] filters ok (--tool/--label/--sort/--top)"

# 9. sessions: both recordings listed with call counts.
SESSIONS="$($CLI sessions --dir "$METER_DIR")"
echo "$SESSIONS" | grep -q "smoke-a \[demo\]" || fail "sessions missing smoke-a"
echo "$SESSIONS" | grep -q "smoke-b" || fail "sessions missing smoke-b"
echo "[smoke] sessions ok"

# 10. Determinism: reporting the same directory twice is byte-identical.
$CLI report --dir "$METER_DIR" --format csv > "$WORKDIR/run1.csv"
$CLI report --dir "$METER_DIR" --format csv > "$WORKDIR/run2.csv"
cmp -s "$WORKDIR/run1.csv" "$WORKDIR/run2.csv" || fail "report is not deterministic"
echo "[smoke] determinism ok"

# 11. The bundled sample sessions aggregate (the README quickstart demo).
$CLI report --dir examples/sample-sessions | grep -q "convert_units" || fail "sample sessions report failed"
$CLI report --dir examples/sample-sessions | grep -q "unanswered 1" || fail "sample unanswered not surfaced"
echo "[smoke] sample sessions ok"

echo "SMOKE OK"
