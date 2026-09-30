import z from "zod"
import { PhotopeaChannel } from "@/Channel"
import type { PhotopeaTransport } from "@/transports/PhotopeaTransport"
import { Contract } from "./Contract"
import { PDocument, PDocuments, type SaveFormat } from "./PDocument"
import { PFile } from "./PFile"
import { Preferences } from "./Preferences"
import { SolidColor } from "./SolidColor"

export class App extends Contract {
  static of(obj: PhotopeaChannel | Contract | PhotopeaTransport) {
    if (obj instanceof Contract) obj = Contract.getChannel(obj)
    if (!(obj instanceof PhotopeaChannel)) obj = new PhotopeaChannel(obj)

    return new App(obj, "app")
  }

  get activeDocument() {
    return this.$(PDocument)`.activeDocument`
  }

  get documents() {
    return this.$(PDocuments)`.documents`
  }

  get version() {
    return this.$value(z.string())`.version`
  }
  get preferences() {
    return this.$(Preferences)`.preferences`
  }
  get backgroundColor() {
    return this.$(SolidColor)`.backgroundColor`
  }
  get foregroundColor() {
    return this.$(SolidColor)`.foregroundColor`
  }

  doAction(action: string, from: string) {
    return this.$eval()`.doAction(${action},${from})`
  }
  executeAction(actionID: number, descriptor?: unknown, display?: string) {
    return this.$eval()`.executeAction(${actionID},${descriptor},${display})`
  }
  executeActionGet(reference: unknown) {
    return this.$eval()`.executeActionGet(${reference})`
  }
  batch(files: unknown, action: string, from: string, options?: unknown) {
    return this.$eval()`.batch(${files},${action},${from},${options})`
  }
  runMenuItem(menuID: number) {
    return this.$eval()`.runMenuItem(${menuID})`
  }
  openDialog() {
    return this.$evalHandle(PFile)`.openDialog()`
  }
  load(file: unknown) {
    return this.$eval()`.load(${file})`
  }
  save() {
    return this.$eval()`.save()`
  }
  makeContactSheet() {
    return this.$eval()`.makeContactSheet()`
  }
  makePDFPresentation() {
    return this.$eval()`.makePDFPresentation()`
  }
  makePhotoGallery() {
    return this.$eval()`.makePhotoGallery()`
  }
  makePhotomerge() {
    return this.$eval()`.makePhotomerge()`
  }
  makePicturePackage() {
    return this.$eval()`.makePicturePackage()`
  }

  // Extra Utils
  async saveToBuffer(format: SaveFormat): Promise<Uint8Array> {
    return await this.activeDocument.saveToBuffer(format)
  }

  /**
   * Opens an image in Photopea from a given URL.
   * Waits for Photopea to be ready and the file to be loaded.
   * @param url The URL of the image to open.
   * @param timeout Maximum time in ms to wait for the file to load (default: 5 minutes).
   * @returns Promise that resolves when the image is loaded.
   */
  async openFromUrl(url: string, timeout?: number) {
    return await this.capabilities.openFromUrl.call(this, url, timeout)
  }

  /**
   * Opens an image in Photopea from a given ArrayBuffer.
   * Waits for Photopea to be ready and the file to be loaded.
   * @param buffer Image data. Will be transferred.
   * @param signal Optional AbortSignal to cancel the operation.
   * @returns Promise that resolves when the image is loaded.
   */
  async openFromBuffer(buffer: ArrayBuffer, signal?: AbortSignal) {
    return await this.capabilities.openFromBuffer.call(this, buffer, signal)
  }

  /**
   * Opens an image in Photopea from a Buffer.
   * @param path The path to the image file.
   * @param timeout The timeout in ms (default: 5 minutes).
   * @returns Promise that resolves when the image is loaded.
   */
  async openFile(path: string, timeout = 5 * 60 * 1000) {
    return await this.capabilities.openFile.call(this, path, timeout)
  }

  async uploadFont(font: Uint8Array, name: string) {
    return await this.uploadFonts({ [name]: font })
  }

  async uploadFonts(fonts: Record<string, Uint8Array>) {
    await this.capabilities.uploadFonts.call(this, fonts)
  }

  async pause() {
    return await this.capabilities.pause.call(this)
  }

  /**
   * Make the given document the active document.
   *
   * Typed wrapper around `activeDocument.$set` for switching between open
   * documents (e.g. copy from one, paste into another). Re-resolve the
   * target with `$ref()` after any `openFile`, which invalidates handles.
   */
  async activateDocument(doc: PDocument) {
    return await this.activeDocument.$set(doc)
  }

  /**
   * Paste the clipboard into the active document via `executeAction`.
   *
   * Prefer this over `PDocument.paste()`: the handle form throws inside
   * smart-object edit sessions, while the action form operates on whichever
   * document is active. Returns whatever Photopea yields (a layer object).
   */
  async paste() {
    return await this.$eval(z.unknown(), { absolute: true })`executeAction(stringIDToTypeID("paste"), undefined, DialogModes.NO)`
  }

  async hasOpenDocument(): Promise<boolean> {
    return await this.channel.evaluate<boolean>(
      "return app.documents.length > 0",
    )
  }

  async tryGetActiveDocument() {
    if (await this.hasOpenDocument()) {
      return await this.activeDocument.$ref()
    }
    return null
  }
}
