# AGENTS.md

## Scope
- Library-only fork for upstream PR to `lifecodeof/autopea`. No client/lab code here — do not add `packages/photo-replace/`, scratch probes, or workflow docs.

## Landmines
- `this.$eval()` expects `void` and throws Zod `invalid_type` if Photopea returns a value (e.g. `paste()` returns the pasted layer). Use `this.$eval(z.unknown())` or an explicit schema when the remote returns data.
- `packages/autopea` exports from `dist/` — rebuild after editing `packages/autopea/src` (`pnpm --filter autopea build`) before typechecking dependents, or checks run against stale output.

## Commands
- pnpm only (workspace `catalog:` + `pnpm@10.33`). Test: `pnpm --filter ./packages/tests run test`. Full check: `pnpm typecheck && pnpm lint`.
