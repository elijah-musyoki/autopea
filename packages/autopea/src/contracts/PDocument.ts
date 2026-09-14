import z from "zod"
import type { DownloadDocumentOptions } from "@/capabilities/PhotopeaCapabilities"
import { ArtLayers } from "./ArtLayer"
import { ColorSamplers } from "./ColorSampler"
import { Contract, ContractCollection } from "./Contract"
import type { AnchorPosition, ResampleMethod, TrimType } from "./enums"
import { Layer, Layers } from "./Layer"
import { LayerSets } from "./LayerSet"
import { type UnitRect, UnitRectLocal } from "./UnitRect"
import type { UnitValue } from "./UnitValue"

export enum SaveFormat {
  PNG = "png",
  JPG = "jpg",
  PSD = "psd",
}

export class PDocument extends Contract {
  get layers() {
    return this.$(Layers)`.layers`
  }
  get artLayers() {
    return this.$(ArtLayers)`.artLayers`
  }
  get layerSets() {
    return this.$(LayerSets)`.layerSets`
  }
  get activeLayer() {
    return this.$(Layer)`.activeLayer`
  }
  get colorSamplers() {
    return this.$(ColorSamplers)`.colorSamplers`
  }

  // Value properties
  get name() {
    return this.$value(z.string())`.name`
  }
  get width() {
    return this.$value(z.number())`.width`
  }
  get height() {
    return this.$value(z.number())`.height`
  }
  get resolution() {
    return this.$value(z.number())`.resolution`
  }
  get mode() {
    return this.$value(z.string())`.mode`
  }
  get saved() {
    return this.$value(z.boolean())`.saved`
  }

  // Methods
  crop(
    bounds: UnitRect,
    angle?: number,
    width?: UnitValue,
    height?: UnitValue,
  ) {
    return this.$eval()`.crop(${bounds},${angle},${width},${height})`
  }
  resizeImage(
    width?: UnitValue,
    height?: UnitValue,
    resolution?: number,
    resampleMethod?: ResampleMethod,
  ) {
    return this.$eval()`.resizeImage(${width},${height},${resolution},${resampleMethod})`
  }
  resizeCanvas(width: UnitValue, height: UnitValue, anchor?: AnchorPosition) {
    return this.$eval()`.resizeCanvas(${width},${height},${anchor})`
  }
  rotateCanvas(angle: number) {
    return this.$eval()`.rotateCanvas(${angle})`
  }
  flipCanvas(direction: string) {
    return this.$eval()`.flipCanvas(${direction})`
  }
  trim(
    trimType?: TrimType,
    top?: boolean,
    left?: boolean,
    bottom?: boolean,
    right?: boolean,
  ) {
    return this.$eval()`.trim(${trimType},${top},${left},${bottom},${right})`
  }
  close(saveOptions?: string) {
    return this.mutexes.documentMutex.runExclusive(
      () => this.$eval()`.close(${saveOptions})`,
    )
  }
  flatten() {
    return this.$eval()`.flatten()`
  }
  mergeVisibleLayers() {
    return this.$eval()`.mergeVisibleLayers()`
  }
  rasterizeAllLayers() {
    return this.$eval()`.rasterizeAllLayers()`
  }
  paste() {
    // Photopea returns the pasted layer object (not void), so accept any value.
    return this.$eval(z.unknown())`.paste()`
  }
  save() {
    return this.$eval()`.save()`
  }

  /** @see https://www.photopea.com/learn/scripts for parameter format */
  saveToOE(param: string) {
    return this.$eval()`.saveToOE(${param})`
  }

  // Extra Utils
  /**
   * Saves document and waits for smart object updated message
   */
  async saveSmartObject() {
    await this.capabilities.saveSmartObject.call(this)
  }

  /**
   * Saves the current or specified document to a buffer in the given format.
   * @param format The format to save as (e.g., 'png', 'jpg').
   * @param document Optional PhotopeaHandle for a specific document. If omitted, uses the active document.
   * @returns Promise that resolves to a Uint8Array containing the saved file data.
   */
  async saveToBuffer(
    format: SaveFormat,
    options?: DownloadDocumentOptions,
  ): Promise<Uint8Array> {
    return await this.capabilities.downloadDocument.call(this, format, options)
  }

  async makeBounds() {
    const width = await this.width.$get()
    const height = await this.height.$get()

    return new UnitRectLocal(0, 0, width, height)
  }

  async duplicate() {
    return await this.capabilities.duplicateDocument.call(this)
  }
}

export class PDocuments extends ContractCollection<PDocument> {
  protected itemType = () => PDocument

  getByName(name: string) {
    return this.$(PDocument)`.getByName(${name})`
  }

  add(width?: number, height?: number, resolution?: number, name?: string) {
    return this.mutexes.documentMutex.runExclusive(
      () =>
        this.$evalHandle(
          PDocument,
        )`.add(${width},${height},${resolution},${name})`,
    )
  }
}
