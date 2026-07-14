# Examples

Everything here is runnable offline and feeds the README quickstart, the
test suite and `scripts/smoke.sh`.

## Files

| File | What it is |
|---|---|
| `demo-server.mjs` | a small stdio MCP "docs assistant" with three tools of very different cost profiles: `search_docs` (fast), `fetch_page` (slow, huge responses), `summarize` (fails on empty input). `DEMO_BANNER=1` makes it print a stray line to stdout at startup — the classic protocol-corruption bug, so you can watch mcpmeter flag junk. |
| `requests.ndjson` | a realistic client-side frame sequence: handshake, `tools/list`, six tool calls (one of which fails), `ping`. Pipe it through the proxy to record a session. |
| `sample-sessions/` | two pre-recorded session files (a labelled dev-laptop run and a CI nightly run, 116 calls total, with an error cluster, junk and one unanswered request) so `mcpmeter report` has something interesting to say without running anything. |

## Try it

```bash
# from the repository root, after `npm install && npm run build`

# 1. Record a session by proxying the demo server
node dist/cli.js run --dir /tmp/meter --label demo -- node examples/demo-server.mjs \
  < examples/requests.ndjson > /dev/null

# 2. Aggregate it
node dist/cli.js report --dir /tmp/meter

# 3. Or skip straight to the bundled recordings
node dist/cli.js report --dir examples/sample-sessions
node dist/cli.js report --dir examples/sample-sessions --sort bytes --format md
node dist/cli.js sessions --dir examples/sample-sessions
```

The sample sessions were generated deterministically (seeded PRNG, fake
clock) through the real `MeterSession` recorder, so their numbers are
stable across machines and the smoke test can assert on them.
