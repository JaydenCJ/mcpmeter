# Contributing to mcpmeter

Issues, discussions and pull requests are all welcome — this project aims to
stay small, zero-dependency at runtime, and invisible on the wire it meters.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/mcpmeter.git
cd mcpmeter
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 91 node:test tests
bash scripts/smoke.sh  # end-to-end proxy + report check
```

`scripts/smoke.sh` meters the bundled demo server through the real proxy,
verifies byte-for-byte passthrough (including a deliberate junk banner),
then aggregates the recordings in all four report formats and checks the
filters — it must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable modules
   (the parser and meter take frames and clocks, not sockets; the CLI is a thin shell).
5. Any change to the session-file schema needs a `schema` bump decision and
   a row update in `docs/session-format.md` — old recordings must keep aggregating.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- **The wire is sacred.** The proxy must never alter, delay or reorder a
  byte of the metered traffic, no matter what the meter thinks of it. Any
  new metering logic runs on a copy and must be throw-free.
- **Metadata only.** Request arguments and result payloads are never
  written to disk. New metrics must be countable without storing content;
  error messages stay truncated.
- Reports must stay deterministic: the same session files always render
  byte-identical output (stable sorts, no wall-clock reads at render time).
- No network calls, ever — mcpmeter spawns the command it is given and
  reads/writes local files, nothing else.
- Exit codes (0 / 1 / 2 / 127 / propagated) and the JSONL event types are
  stable API; changing them is a breaking change.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `mcpmeter --version` output, the exact command line, your
client and server (names and versions are enough), and if at all possible
the session `.jsonl` file — it contains metadata only (methods, timings,
byte counts, truncated error text), but skim it before attaching. For
parsing bugs, a captured byte sequence that misparses is gold.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead.
