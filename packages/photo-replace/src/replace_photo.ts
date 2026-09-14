// Interop note: autopea's Contract API is dynamically typed by design (remote
// expressions evaluated in Photopea), so `any` casts below are the boundary
// translation layer, not sloppy typing. Every dynamic result that matters is
// re-verified at runtime (layer counts after paste, `saved` flags after save)
// before the flow proceeds — that verification IS the boundary parsing here.
// A future cleanup could introduce branded doc/layer handles; the runtime
// asserts must stay regardless, since Photopea can silently no-op on stale
// handles (see AGENT_HANDOFF.md).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buffer } from "node:stream/consumers";
import { chromium, type Browser, type Page } from "playwright";
import { PhotopeaPage } from "autopea-playwright";
import { App } from "autopea/contracts/App";
import { unzipSync } from "fflate/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

type Args = {
  psd: string;
  photo: string;
  outPsd: string;
  outPng: string;
  /** Nested group path to the smart-object layer, e.g. ["DL","Photo","Photo"]. */
  layerPath: string[];
  /** Name of the pixel layer inside the inner PSB (e.g. "Слой 1"). */
  innerName: string;
  /** Name of the old layer to remove after paste (e.g. "Background"). */
  removeName: string;
  watchdogMs: number;
  logDir: string;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const multi = (flag: string, fallback: string[]): string[] => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1].split("/") : fallback;
  };
  const layerPath = multi("--layer-path", ["DL", "Photo", "Photo"]);
  if (layerPath.length !== 3 || layerPath.some((s) => s.length === 0)) {
    throw new Error("--layer-path must be top/group/leaf (e.g. DL/Photo/Photo)");
  }
  return {
    psd: resolve(get("--psd", "/home/elijah/Projects/psd-dissection-lab/workspace/working.psd")),
    photo: resolve(get("--photo", "/home/elijah/Projects/psd-dissection-lab/workspace/test_replacement_1203x1466.png")),
    outPsd: resolve(get("--out-psd", "/home/elijah/Projects/psd-dissection-lab/workspace/working_replaced_final.psd")),
    outPng: resolve(get("--out-png", "/home/elijah/Projects/psd-dissection-lab/workspace/working_replaced_final.png")),
    layerPath,
    innerName: get("--inner-name", "Слой 1"),
    removeName: get("--remove-name", "Background"),
    watchdogMs: Number(get("--watchdog-ms", String(15 * 60_000))),
    logDir: resolve(get("--log-dir", __dirname + "/logs")),
  };
}

type StepName =
  | "validate_inputs"
  | "launch_browser"
  | "open_psd"
  | "find_photo"
  | "open_smart_objects"
  | "open_photo"
  | "copy_photo"
  | "paste_into_inner"
  | "remove_old"
  | "fit_and_save_chain"
  | "export_png"
  | "export_psd";

type WideEvent = {
  run_id: string;
  ts: string;
  duration_ms: number;
  outcome: "success" | "error";
  level: "info" | "error";
  args: { psd: string; photo: string; outPsd: string; outPng: string };
  photo_bytes?: number;
  output_psd_bytes?: number;
  output_png_bytes?: number;
  docs?: { parent?: string; outer?: string; inner?: string; photo?: string };
  steps_ms: Partial<Record<StepName, number>>;
  error?: { step: StepName | "unknown"; message: string; type: string };
  artifacts?: { error_screenshot?: string; log_path?: string };
};

function logWide(event: WideEvent): void {
  (event.level === "error" ? console.error : console.log)(JSON.stringify(event));
}

function logStep(runId: string, phase: "start" | "done" | "fail", step: StepName | "unknown", extra?: Record<string, unknown>): void {
  console.error(JSON.stringify({ kind: "step", run_id: runId, phase, step, ts: new Date().toISOString(), ...extra }));
}

async function writeProgress(logDir: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const p = resolve(logDir, `${runId}.progress.json`);
    await mkdir(logDir, { recursive: true });
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
    } catch { /* first write */ }
    await writeFile(p, `${JSON.stringify({ ...prev, ...patch, run_id: runId, updated_at: new Date().toISOString() }, null, 2)}\n`);
  } catch { /* progress must never fail the run */ }
}

async function timed<T>(ctx: { runId: string; steps: WideEvent["steps_ms"]; logDir: string }, step: StepName, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  logStep(ctx.runId, "start", step);
  try {
    const result = await fn();
    ctx.steps[step] = Date.now() - start;
    logStep(ctx.runId, "done", step, { ms: ctx.steps[step] });
    return result;
  } catch (err) {
    ctx.steps[step] = Date.now() - start;
    logStep(ctx.runId, "fail", step, { ms: ctx.steps[step], message: String(err).slice(0, 300) });
    throw err;
  }
}

function need(value: string | undefined, what: string): string {
  if (value === undefined || value.length === 0) throw new Error(`missing ${what}`);
  return value;
}

async function docByName(app: any, name: string) {
  const n = await app.documents.length.$get();
  for (let i = 0; i < n; i++) {
    const d = app.documents.get(i);
    if ((await d.name.$get()) === name) return await d.$ref();
  }
  throw new Error(`doc not found: ${name}`);
}

async function downloadActive(page: any, doc: any, optsExpr: string, timeoutMs: number): Promise<Uint8Array> {
  const dlPromise = (page as any).page.waitForEvent("download", { timeout: timeoutMs });
  await (doc as any).channel.evaluate(
    `app.activeDocument.saveAs(new File(""), ${optsExpr})`,
    {},
    { timeout: timeoutMs },
  );
  const dl = await dlPromise;
  const stream = await (dl as any).createReadStream();
  const zip = await buffer(stream);
  try { (stream as any).destroy(); } catch { /* ignore */ }
  const parts = unzipSync(new Uint8Array(zip));
  return parts[Object.keys(parts)[0]] as Uint8Array;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = randomUUID();
  const started = Date.now();
  const event: WideEvent = {
    run_id: runId,
    ts: new Date().toISOString(),
    duration_ms: 0,
    outcome: "success",
    level: "info",
    args: { psd: args.psd, photo: args.photo, outPsd: args.outPsd, outPng: args.outPng },
    steps_ms: {},
    docs: {},
  };
  const ctx = { runId, steps: event.steps_ms, logDir: args.logDir };
  const docs: { parent?: string; outer?: string; inner?: string; photo?: string } = {};
  let browser: Browser | undefined;
  let page: Page | undefined;
  let currentStep: StepName | "unknown" = "unknown";

  const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ kind: "run.timeout", run_id: runId, duration_ms: Date.now() - started }));
    process.exit(1);
  }, args.watchdogMs);
  watchdog.unref?.();

  try {
    currentStep = "validate_inputs";
    const photoBuffer = await timed(ctx, "validate_inputs", async () => {
      const [photo, psd] = await Promise.all([readFile(args.photo), readFile(args.psd)]);
      if (photo.byteLength === 0 || psd.byteLength === 0) throw new Error("empty input file");
      return photo;
    });
    event.photo_bytes = photoBuffer.byteLength;
    await mkdir(dirname(args.outPsd), { recursive: true });

    currentStep = "launch_browser";
    browser = await timed(ctx, "launch_browser", () => chromium.launch({ headless: false }));
    const photopeaPage = await PhotopeaPage.openFromBrowser(browser);
    page = photopeaPage.page;
    const app = App.of(photopeaPage);

    currentStep = "open_psd";
    const doc = await timed(ctx, "open_psd", () => app.openFile(args.psd, 5 * 60 * 1000));
    docs.parent = await doc.name.$get();

    // Nested traversal: layerSets... layerSets... artLayers (Florida DL layout).
    // getByName builds a lazy expression — nothing executes until $get/$set.
    currentStep = "find_photo";
    const photoLayer = await timed(ctx, "find_photo", async () => {
      const [top, group, leaf] = args.layerPath;
      const layer = app.activeDocument.layerSets.getByName(top).layerSets.getByName(group).artLayers.getByName(leaf);
      await layer.name.$get(); // forces evaluation; throws if path is wrong
      return layer;
    });

    currentStep = "open_smart_objects";
    const outerDoc: any = await timed(ctx, "open_smart_objects", () => (photoLayer as any).openSmartObject());
    docs.outer = await outerDoc.name.$get();
    const innerLayer = (outerDoc as any).artLayers.getByName(args.innerName);
    const innerDoc: any = await (innerLayer as any).openSmartObject();
    docs.inner = await innerDoc.name.$get();

    // openFile, never openFromBuffer (blankMessage hang in this setup).
    currentStep = "open_photo";
    const pngDoc = await timed(ctx, "open_photo", () => app.openFile(args.photo, 60_000));
    docs.photo = await pngDoc.name.$get();

    currentStep = "copy_photo";
    await timed(ctx, "copy_photo", async () => {
      await app.activeDocument.$set(await pngDoc.$ref() as any);
      await (app.activeDocument as any).$eval()`.selection.selectAll()`;
      await (app.activeDocument as any).$eval()`.selection.copy()`;
    });

    // Re-resolve handles fresh: any openFile invalidates prior __ppHandle refs,
    // making save()/paste() silently no-op on them. Paste via handle-free
    // executeAction (PDocument.paste() also mis-reports success as a Zod error).
    currentStep = "paste_into_inner";
    await timed(ctx, "paste_into_inner", async () => {
      const innerFresh = await docByName(app, need(docs.inner, "doc tab name"));
      await app.activeDocument.$set(innerFresh as any);
      await (app.activeDocument as any).$eval({ absolute: true })`executeAction(stringIDToTypeID("paste"), undefined, DialogModes.NO)`;
      const n = await (innerFresh as any).artLayers.length.$get();
      if (n < 2) throw new Error(`paste produced no new layer (artLayers=${n})`);
    });

    currentStep = "remove_old";
    await timed(ctx, "remove_old", async () => {
      const innerFresh = await docByName(app, need(docs.inner, "doc tab name"));
      const n = await (innerFresh as any).artLayers.length.$get();
      for (let i = 0; i < n; i++) {
        const l = (innerFresh as any).artLayers.get(i);
        if ((await l.name.$get()) === args.removeName) {
          await l.remove();
          return;
        }
      }
      throw new Error(`layer to remove not found: ${args.removeName}`);
    });

    currentStep = "fit_and_save_chain";
    await timed(ctx, "fit_and_save_chain", async () => {
      const innerFresh = await docByName(app, need(docs.inner, "doc tab name"));
      await app.activeDocument.$set(innerFresh as any);
      await (innerFresh as any).artLayers.get(0).fitToBounds({ grow: true });
      await (innerFresh as any).save();
      if (!(await (innerFresh as any).saved.$get())) throw new Error("inner save did not stick (stale handle?)");
      try { await (innerFresh as any).saveSmartObject(); } catch (e) { console.error(JSON.stringify({ kind: "warn", note: "inner_saveSmartObject", error: String(e).slice(0, 200) })); }
      await pngDoc.close("DONOTSAVECHANGES").catch(() => undefined);

      const outerFresh = await docByName(app, need(docs.outer, "doc tab name"));
      await app.activeDocument.$set(outerFresh as any);
      await (outerFresh as any).save();
      if (!(await (outerFresh as any).saved.$get())) throw new Error("outer save did not stick (stale handle?)");
      try { await (outerFresh as any).saveSmartObject(); } catch (e) { console.error(JSON.stringify({ kind: "warn", note: "outer_saveSmartObject", error: String(e).slice(0, 200) })); }

      const workingFresh = await docByName(app, need(docs.parent, "doc tab name"));
      await app.activeDocument.$set(workingFresh as any);
    });

    // Long timeouts: library downloadDocument hardcodes 10s evaluate, which
    // cannot export a 370MB document. Our fork accepts DownloadDocumentOptions;
    // this path inlines the same logic with explicit budgets.
    currentStep = "export_png";
    const pngBytes = await timed(ctx, "export_png", () => downloadActive(photopeaPage, app.activeDocument, "new PNGSaveOptions()", 300_000));
    await writeFile(args.outPng, pngBytes);
    event.output_png_bytes = pngBytes.byteLength;

    currentStep = "export_psd";
    const psdBytes = await timed(ctx, "export_psd", () => downloadActive(photopeaPage, app.activeDocument, "new PhotoshopSaveOptions()", 420_000));
    await writeFile(args.outPsd, psdBytes);
    event.output_psd_bytes = psdBytes.byteLength;
  } catch (err) {
    event.outcome = "error";
    event.level = "error";
    const error = err instanceof Error ? err : new Error(String(err));
    event.error = { step: currentStep, message: error.message.slice(0, 500), type: error.name };
    if (page) {
      try {
        const shot = resolve(args.logDir, `${runId}-error.png`);
        await mkdir(args.logDir, { recursive: true });
        await page.screenshot({ path: shot, fullPage: false });
        event.artifacts = { ...event.artifacts, error_screenshot: shot };
      } catch { /* keep original error */ }
    }
  } finally {
    event.docs = docs;
    event.duration_ms = Date.now() - started;
    event.ts = new Date().toISOString();
    try {
      await mkdir(args.logDir, { recursive: true });
      const logPath = resolve(args.logDir, `${runId}.json`);
      await writeFile(logPath, `${JSON.stringify(event, null, 2)}\n`);
      event.artifacts = { ...event.artifacts, log_path: logPath };
    } catch { /* still emit stdout */ }
    logWide(event);
    clearTimeout(watchdog);
    await browser?.close().catch(() => undefined);
  }

  if (event.outcome === "error") process.exitCode = 1;
}

main();
