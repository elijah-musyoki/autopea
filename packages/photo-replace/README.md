# photo-replace

Production photo replacement for PSD smart objects. Consolidates the
`packages/tests/scratch/probe_*.ts` findings (and the old Quebec `replace.ts`
harness) into one runnable script against our fork.

## Run

```bash
DISPLAY=:0 bun run src/replace_photo.ts \
  --psd /path/to/working.psd \
  --photo /path/to/replacement.png \
  --out-psd /path/to/out.psd \
  --out-png /path/to/out.png
```

Defaults target the Florida DL workspace file. For a different nesting, pass
`--layer-path DL/Photo/Photo --inner-name "Слой 1" --remove-name Background`.

Stdout carries one JSON wide-event per run; human step lines go to stderr.
Per-run JSON + progress land in `src/logs/`.

## Rules baked in (do not regress)

- Nested `getByName` traversal; flat `artLayers.getByName` at top level throws.
- `openFile` for local images — never `openFromBuffer` (blankMessage hang).
- Re-resolve every doc handle after each `openFile` (`docByName`); stale
  `__ppHandle`s make `save()`/`paste()` silently no-op — assert `saved`.
- Paste via `executeAction(paste)`, not `PDocument.paste()`.
- Exports use explicit long timeouts (10s library default can't do 370MB).
