import { buffer } from "node:stream/consumers"
import type {
  DownloadDocumentOptions,
  PhotopeaCapabilities,
} from "autopea"
import {
  abortOnTimeout,
  invariant,
  PhotopeaMutexes,
  waitForEvent,
} from "autopea"
import { App } from "autopea/contracts/App"
import type { ArtLayer } from "autopea/contracts/ArtLayer"
import { type PDocument, SaveFormat } from "autopea/contracts/PDocument"
import { unzipSync } from "fflate/node"
import type { ConsoleMessage, Dialog } from "playwright"
import { errors as pwErrors } from "playwright"
import type { PhotopeaPage } from "../PhotopeaPage"
import { makeBase64ToArrayBufferFnHandle } from "../playwrightLib"
import { clickToolbarButton } from "../toolbar"

const saveFormatMap = {
  [SaveFormat.PNG]: "new PNGSaveOptions()",
  [SaveFormat.JPG]: "new JPEGSaveOptions()",
  [SaveFormat.PSD]: "new PhotoshopSaveOptions()",
} as const

export const createPlaywrightCapabilities = (
  pPage: PhotopeaPage,
): PhotopeaCapabilities => {
  const page = pPage.page

  return {
    getMutexes() {
      return PhotopeaMutexes.of(pPage.page)
    },
    openSmartObject(this: ArtLayer): Promise<PDocument> {
      return this.mutexes.documentMutex.runExclusive(async () => {
        const panelhead = await page
          .locator(".mainblock > .block > .panelhead")
          .elementHandle()
        invariant(panelhead, "Cannot find panelhead element")

        const documentCountBefore = await panelhead.evaluate(
          (el) => el.childElementCount,
        )

        await App.of(this).activeDocument.activeLayer.$set(this)

        await this.$eval({
          absolute: true,
        })`executeAction(stringIDToTypeID("placedLayerEditContents"), null, DialogModes.NO)`

        // Wait for new document tab to open
        await page.waitForFunction(
          ([panelhead, count]) => panelhead.childElementCount === count + 1,
          [panelhead, documentCountBefore] as const,
        )

        return await App.of(this).activeDocument.$ref()
      })
    },
    openFile(this: App, path: string, timeout = 5 * 60 * 1000) {
      const abort = new AbortController()

      return this.mutexes.interactionMutex.runExclusive(async () => {
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout }),
          clickToolbarButton(page, [1, 2]), // File > Open
        ])

        return await this.mutexes.documentMutex.runExclusive(async () => {
          const blankMessagePromise = waitForEvent(pPage.on, {
            event: "blankMessage",
            signal: abort.signal,
          })

          await fileChooser.setFiles(path)

          const cleanup = abortOnTimeout(
            abort,
            timeout,
            new Error(`openFile() timed out after ${timeout}ms`),
          )

          try {
            await blankMessagePromise
            return this.activeDocument.$ref()
          } finally {
            cleanup()
          }
        })
      })
    },
    openFromUrl(
      this: App,
      url: string,
      timeout = 5 * 60 * 1000,
    ): Promise<PDocument> {
      return this.mutexes.documentMutex.runExclusive(async () => {
        await Promise.all([
          waitForEvent(pPage.on, {
            signal: AbortSignal.timeout(timeout),
            event: "blankMessage",
          }),
          this.channel.evaluate<void>(`app.open(${JSON.stringify(url)});`),
        ])

        return this.activeDocument.$ref()
      })
    },
    openFromBuffer(
      this: App,
      buffer: ArrayBuffer,
      signal?: AbortSignal,
    ): Promise<PDocument> {
      return this.mutexes.documentMutex.runExclusive(async () => {
        await Promise.all([
          waitForEvent(pPage.on, {
            signal: signal ?? AbortSignal.timeout(5 * 60 * 1000),
            event: "blankMessage",
          }),
          pPage.sendMessage(buffer),
        ])

        return this.activeDocument.$ref()
      })
    },
    async uploadFonts(this: App, fonts: Record<string, Uint8Array>) {
      const fontsBase64 = Object.entries(fonts).map(([name, buffer]) => ({
        name,
        base64: Buffer.from(buffer).toString("base64"),
      }))

      const toArrayBuffer = await makeBase64ToArrayBufferFnHandle(page)

      await this.mutexes.dialogMutex.runExclusive(async () => {
        let dialogListener: ((dialog: Dialog) => void) | null = null
        try {
          const dataTransfer = await page.evaluateHandle(
            ([fontsBase64, toArrayBuffer]) => {
              const dataTransfer = new DataTransfer()
              for (const { name, base64 } of fontsBase64) {
                const buffer = toArrayBuffer(base64)
                dataTransfer.items.add(new File([buffer], name))
              }
              return dataTransfer
            },
            [fontsBase64, toArrayBuffer] as const,
          )

          dialogListener = (dialog: Dialog) => dialog.dismiss()
          page.on("dialog", dialogListener)

          // Photopea no longer logs array with Uint8Array
          const consolePromise = page.waitForEvent(
            "console",
            async (msg: ConsoleMessage) => {
              const args = msg.args()
              if (args.length === 0) return false
              const firstArg = args[0]

              const message = await firstArg.jsonValue()
              if (
                typeof message === "string" &&
                /Alert: Font .* loaded/.test(message)
              )
                return true

              return await firstArg.evaluate((arg: unknown) => {
                const payload = arg as { 0?: { _data?: Uint8Array } }
                return payload[0]?._data instanceof Uint8Array
              })
            },
          )

          await page.dispatchEvent(
            ".mainblock > .block > .body",
            "drop",
            { dataTransfer },
            { strict: true },
          )

          await consolePromise.catch((err: unknown) => {
            // Timeouts are fine here
            if (!(err instanceof pwErrors.TimeoutError)) throw err
          })
        } finally {
          await toArrayBuffer.dispose()
          if (dialogListener) page.off("dialog", dialogListener)
        }
      })
    },
    pause() {
      return page.pause()
    },
    async saveSmartObject(this: PDocument) {
      const waiter = page.waitForEvent(
        "console",
        async (msg: ConsoleMessage) => {
          const args = msg.args()
          if (args.length === 0) return false
          const firstArg = args[0]
          return await firstArg.evaluate(
            (arg: string) => arg === "Alert: Smart Object updated",
          )
        },
      )

      await this.save()
      await waiter
    },
    async downloadDocument(
      this: PDocument,
      format: SaveFormat,
      options?: DownloadDocumentOptions,
    ) {
      return this.mutexes.downloadMutex.runExclusive(async () => {
        const downloadPromise = page.waitForEvent("download", {
          timeout: options?.downloadTimeout,
        })
        await this.channel.evaluate<void>(
          `doc.saveAs(new File(""), ${saveFormatMap[format]})`,
          { doc: this },
          { timeout: options?.evaluateTimeout ?? 10_000 },
        )
        const download = await downloadPromise

        const downloadStream = await download.createReadStream()
        try {
          const zip = await buffer(downloadStream)
          return extractSingleFileFromZip(zip)
        } finally {
          downloadStream.destroy()
        }
      })
    },
    async duplicateDocument(this: PDocument) {
      await clickToolbarButton(page, [
        3, // Image
        20, // Duplicate
      ])

      return await App.of(this).activeDocument.$ref()
    },
  }
}

function extractSingleFileFromZip(zipBuffer: Buffer): Uint8Array {
  const decompressed = unzipSync(zipBuffer)
  const entries = Object.keys(decompressed)

  if (entries.length !== 1) {
    throw new Error(
      `Zip archive must contain exactly one file, found ${entries.length}`,
    )
  }

  return decompressed[entries[0]]
}
