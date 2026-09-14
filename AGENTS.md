# AGENTS.md

## Landmines (silent failures — assert, don't assume)

- Re-resolve every doc handle after any `openFile`: opening a file
  invalidates prior `__ppHandle` refs and `save()`/`paste()` silently no-op
  on them. Re-fetch via `$ref()` and assert `saved === true` after saves,
  layer counts after pastes.
- `downloadDocument` defaults to a 10s evaluate timeout: large documents
  need `saveToBuffer(format, { evaluateTimeout, downloadTimeout })`.
- `openFromBuffer` can hang forever waiting for `blankMessage`; prefer
  `openFile` for local files. `saveToOE`/`clearHistory` throw on very large
  documents; use `saveAs` + download instead.

## Commands

- After changing `packages/autopea/src`, rebuild it before typechecking
  dependents — they resolve `autopea` from `dist`, so `tsc` will check
  against stale output otherwise.
- Run `packages/tests/scratch/*.ts` probes with `bun run` from
  `packages/tests/` (module resolution), never through vitest.
- Browser runs need a display (`DISPLAY=:0`, `headless: false`); on
  memory-squeezed hosts run one browser/one tab at a time.
