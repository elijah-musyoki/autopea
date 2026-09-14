import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { PhotopeaPage } from "autopea-playwright";
import { App } from "autopea/contracts/App";
import type { PDocument } from "autopea/contracts/PDocument";
import { SaveFormat } from "autopea/contracts/PDocument";

const __dirname = dirname(fileURLToPath(import.meta.url));

type Args = {
  psd: string;
  photo: string;
  outPsd: string;
  outPng: string;
  /** Nested group path to the smart-object layer, e.g. ["DL","Photo","Photo"]. */
  layerPath: [string, string, string];
  /** Name of the pixel layer inside the inner PSB (e.g. "Слой 1"). */
  innerName: string;
  /** Name of the old layer to remove after paste (e.g. "Background"). */
  removeName: string;
  watchdogMs: number;
  logDir: string;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const rawPath = get("--layer-path", "DL/Photo/Photo").split("/");
  if (rawPath.length !== 3 || rawPath.some((s) => s.length === 0)) {
    throw new Error("--layer-path must be top/group/leaf (e.g. DL/Photo/Photo)");
  }
  return {
    psd: resolve(get("--psd", "/home/elijah/Projects/psd-dissection-lab/workspace/working.psd")),
    photo: resolve(get("--photo", "/home/elijah/Projects/psd-dissection-lab/workspace/test_replacement_1203x1466.png")),
    outPsd: resolve(get("--out-psd", "/home/elijah/Projects/psd-dissection-lab/workspace/working_replaced_final.psd")),
    outPng: resolve(get("--out-png", "/home/elijah/Projects/psd-dissection-lab/workspace/working_replaced_final.png")),
    layerPath: [rawPath[0], rawPath[1], rawPath[2]],
    innerName: get("--inner-name", "Слой 1"),
    removeName: get("--remove-name", "Background"),
    watchdogMs: Number(get("--watchdog-ms", String(15 * 60_000))),
    logDir: resolve(get("--log-dir", `${__dirname}/logs`)),
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
  /** Environment characteristics for deployment correlation. */
  service: string;
  version: string;
  commit: string;
  region: string;
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

function need(value: string | undefined, what: string): string {
  if (value === undefined || value.length === 0) throw new Error(`missing ${what}`);
  return value;
}

async function timed<T>(ctx: { runId: string; steps: WideEvent["steps_ms"] }, step: StepName, fn: () => Promise<T>): Promise<T> {
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

function loadEnv(): { service: string; version: string; commit: string; region: string } {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch { /* run from source without package metadata */ }
  return {
    service: "photo-replace",
    version,
    commit: process.env.GIT_COMMIT ?? "unknown",
    region: process.env.REGION ?? "local",
  };
}

/**
 * Find an open document tab by name and pin it with a fresh handle.
 *
 * Fresh handles are required after any `openFile`, which invalidates prior
 * `__ppHandle` refs and makes `save()` silently no-op on them.
 */
async function docByName(app: App, name: string): Promise<PDocument> {
  const n = await app.documents.length.$get();
  for (let i = 0; i < n; i++) {
    const d = app.documents.get(i);
    if ((await d.name.$get()) === name) return await d.$ref();
  }
  throw new Error(`doc not found: ${name}`);
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
    ...loadEnv(),
    args: { psd: args.psd, photo: args.photo, outPsd: args.outPsd, outPng: args.outPng },
    steps_ms: {},
    docs: {},
  };
  const ctx = { runId, steps: event.steps_ms };
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
    const outerDoc = await timed(ctx, "open_smart_objects", () => photoLayer.openSmartObject());
    docs.outer = await outerDoc.name.$get();
    const innerLayer = outerDoc.artLayers.getByName(args.innerName);
    const innerDoc = await innerLayer.openSmartObject();
    docs.inner = await innerDoc.name.$get();

    // openFile, never openFromBuffer (blankMessage hang in this setup).
    currentStep = "open_photo";
    const pngDoc = await timed(ctx, "open_photo", () => app.openFile(args.photo, 60_000));
    docs.photo = await pngDoc.name.$get();

    currentStep = "copy_photo";
    await timed(ctx, "copy_photo", async () => {
      await app.activateDocument(await pngDoc.$ref());
      const active = app.activeDocument;
      await active.selectAll();
      await active.copySelection();
    });

    currentStep = "paste_into_inner";
    await timed(ctx, "paste_into_inner", async () => {
      const innerFresh = await docByName(app, need(docs.inner, "inner doc tab name"));
      await app.activateDocument(innerFresh);
      await app.paste();
      const n = await innerFresh.artLayers.length.$get();
      if (n < 2) throw new Error(`paste produced no new layer (artLayers=${n})`);
    });

    currentStep = "remove_old";
    await timed(ctx, "remove_old", async () => {
      const innerFresh = await docByName(app, need(docs.inner, "inner doc tab name"));
      const n = await innerFresh.artLayers.length.$get();
      for (let i = 0; i < n; i++) {
        const l = innerFresh.artLayers.get(i);
        if ((await l.name.$get()) === args.removeName) {
          await l.remove();
          return;
        }
      }
      throw new Error(`layer to remove not found: ${args.removeName}`);
    });

    currentStep = "fit_and_save_chain";
    await timed(ctx, "fit_and_save_chain", async () => {
      const innerFresh = await docByName(app, need(docs.inner, "inner doc tab name"));
      await app.activateDocument(innerFresh);
      await innerFresh.artLayers.get(0).fitToBounds({ grow: true });
      await innerFresh.save();
      if (!(await innerFresh.saved.$get())) throw new Error("inner save did not stick (stale handle?)");
      try {
        await innerFresh.saveSmartObject();
      } catch (e) {
        console.error(JSON.stringify({ kind: "warn", note: "inner_saveSmartObject", error: String(e).slice(0, 200) }));
      }
      await pngDoc.close("DONOTSAVECHANGES").catch(() => undefined);

      const outerFresh = await docByName(app, need(docs.outer, "outer doc tab name"));
      await app.activateDocument(outerFresh);
      await outerFresh.save();
      if (!(await outerFresh.saved.$get())) throw new Error("outer save did not stick (stale handle?)");
      try {
        await outerFresh.saveSmartObject();
      } catch (e) {
        console.error(JSON.stringify({ kind: "warn", note: "outer_saveSmartObject", error: String(e).slice(0, 200) }));
      }

      const workingFresh = await docByName(app, need(docs.parent, "working doc tab name"));
      await app.activateDocument(workingFresh);
    });

    // Long budgets: the 10s library default cannot export a 370MB document.
    currentStep = "export_png";
    const pngBytes = await timed(ctx, "export_png", () =>
      app.activeDocument.saveToBuffer(SaveFormat.PNG, { evaluateTimeout: 300_000, downloadTimeout: 300_000 }),
    );
    await writeFile(args.outPng, pngBytes);
    event.output_png_bytes = pngBytes.byteLength;

    currentStep = "export_psd";
    const psdBytes = await timed(ctx, "export_psd", () =>
      app.activeDocument.saveToBuffer(SaveFormat.PSD, { evaluateTimeout: 420_000, downloadTimeout: 420_000 }),
    );
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
