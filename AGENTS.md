# AGENTS.md

## Scope
- Library-only fork for upstream PR to `lifecodeof/autopea`. No client/lab code here — do not add `packages/photo-replace/`, scratch probes, or workflow docs.

## Landmines
- `this.$eval()` expects `void` and throws Zod `invalid_type` if Photopea returns a value (e.g. `paste()` returns the pasted layer). Use `this.$eval(z.unknown())` or an explicit schema when the remote returns data.
- Inside smart-object edit sessions, `PDocument` handle calls throw at the Photopea level (verified: `__ppHandle__.paste()` fails after `openSmartObject` on the golden file). Prefer action-form equivalents such as `App.paste()`.
- Large exports throw under the 10s default (verified: default `saveToBuffer(PNG)` fails on the 370MB golden). Pass `DownloadDocumentOptions` with generous `evaluateTimeout`/`downloadTimeout`.
- `packages/autopea` exports from `dist/` — rebuild after editing `packages/autopea/src` (`pnpm --filter autopea build`) before typechecking dependents, or checks run against stale output.

## Commands
- pnpm only (workspace `catalog:` + `pnpm@10.33`). Test: `pnpm --filter ./packages/tests run test`. Full check: `pnpm typecheck && pnpm lint`.
