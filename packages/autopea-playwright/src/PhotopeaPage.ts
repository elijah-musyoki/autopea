import type {
  PhotopeaCapabilities,
  PhotopeaTransport,
  PhotopeaTransportEventMap,
} from "autopea"
import { createNanoEvents } from "nanoevents"
import type { Browser, BrowserContext, Page } from "playwright"
import { createPlaywrightCapabilities } from "./capabilities/PlaywrightPhotopeaCapabilities"
import { makeArrayBufferToBase64FnHandle } from "./playwrightLib"

type EventMap = PhotopeaTransportEventMap & {
  message: (message: string) => void
  bufferMessage: (buffer: Buffer) => void
}

type NamedFn = (...args: unknown[]) => unknown

type PhotopeaWindow = Window & {
  __name?: (fn: NamedFn) => NamedFn
  isFirstDoneFired?: boolean
  onPhotopeaMessage?: (data: string, isBase64: boolean) => void
  showOpenFilePicker?: undefined
  parent?: {
    postMessage: (msg: string, _targetOrigin: string) => void
  }
}

/**
 * Represents a browser page running Photopea, providing event-driven communication and utility methods.
 * Extends EventEmitter to emit Photopea-specific events.
 */
export class PhotopeaPage implements PhotopeaTransport {
  public readonly capabilities: PhotopeaCapabilities

  private messageBuffer: string = ""

  private readonly events = createNanoEvents<EventMap>()

  /**
   * @param page The Playwright Page instance.
   * @param iframeHandle The JSHandle for the Photopea iframe.
   */
  private constructor(public readonly page: Page) {
    this.capabilities = createPlaywrightCapabilities(this)
  }

  on = <K extends keyof EventMap>(event: K, handler: EventMap[K]) => {
    return this.events.on(event, handler)
  }

  private emit<K extends keyof EventMap>(
    event: K,
    ...args: Parameters<EventMap[K]>
  ) {
    this.events.emit(event, ...args)
  }

  /**
   * Opens a new PhotopeaPage from a Playwright Browser or BrowserContext.
   * @param browserOrContext The Playwright Browser or BrowserContext.
   * @param options Optional configuration options.
   * @returns Promise resolving to a PhotopeaPage instance.
   */
  static async openFromBrowser(
    browserOrContext: Browser | BrowserContext,
    options: { timeout?: number } = {},
  ) {
    return await PhotopeaPage.open(await browserOrContext.newPage(), options)
  }

  /**
   * Opens a new PhotopeaPage from a Playwright Page.
   * @param page The Playwright Page instance.
   * @param options Optional configuration options.
   * @returns Promise resolving to a PhotopeaPage instance.
   */
  static async open(page: Page, options: { timeout?: number } = {}) {
    await PhotopeaPage.openPhotopeaPage(page, options)
    const instance = new PhotopeaPage(page)
    await instance.listenEvents()
    return instance
  }

  private handleMessage(message: string, isBase64: boolean) {
    // Buffer messages until "done" is received
    if (message === "done") {
      if (this.messageBuffer.length <= 0) this.emit("blankMessage")
      this.emit("message", this.messageBuffer)
      this.messageBuffer = ""
    } else if (isBase64) {
      this.emit("bufferMessage", Buffer.from(message, "base64"))
    } else {
      this.messageBuffer += message
    }
  }

  private static async openPhotopeaPage(
    page: Page,
    options: { timeout?: number } = {},
  ) {
    // Filter out unwanted scripts
    await page.route("**/*", (route) => {
      const request = route.request()
      if (
        request.resourceType() === "script" &&
        !/^https:\/\/(www\.)?(vec|photo)pea\.com/.test(request.url())
      ) {
        // Block disallowed scripts
        route.abort()
      } else {
        route.continue()
      }
    })

    const toBase64Handle = await makeArrayBufferToBase64FnHandle(page)

    await page.addInitScript((toBase64) => {
      const pageWindow = window as PhotopeaWindow
      pageWindow.__name = (fn: NamedFn) => fn
      pageWindow.isFirstDoneFired = false
      pageWindow.showOpenFilePicker = undefined // Disable file access API

      function listener(event: MessageEvent): void {
        if (event.origin === "https://www.photopea.com") {
          if (event.data === "done") {
            pageWindow.isFirstDoneFired = true
          }

          if (pageWindow.onPhotopeaMessage) {
            let data = event.data
            const isBase64 = data instanceof ArrayBuffer
            if (isBase64) {
              data = toBase64(data)
            }

            pageWindow.onPhotopeaMessage(data, isBase64)
          }
        }
      }

      // Temp compatibility for old iframe solution
      // window.addEventListener("message", listener)

      // Mock parent.postMessage for echoToOE() and saveToOE()
      // Photopea checks window === window.parent
      const mockParent = {
        postMessage(msg: string, _targetOrigin: string) {
          listener(
            new MessageEvent("message", {
              origin: "https://www.photopea.com",
              data: msg,
            }),
          )
        },
      }
      ;(pageWindow as unknown as { parent: typeof mockParent }).parent =
        mockParent

      // Skip landing page
      localStorage.setItem("_ppp", '{"capShown":"false"}')
    }, toBase64Handle)

    await toBase64Handle.dispose()

    // Undocumented Photopea URL fragment that suppresses the landing page ads.
    // This is fragile and may break if Photopea changes their client-side routing.
    const AD_FRAGMENT = "#8887"
    const startTime = Date.now()
    const timeout = options.timeout ?? 30_000
    try {
      await page.goto(`https://www.photopea.com${AD_FRAGMENT}`, { timeout })
    } catch (error) {
      if (Date.now() - startTime < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      } else {
        throw error
      }
    }

    // Wait for the first "done" message
    await page.waitForFunction(
      () => (window as PhotopeaWindow).isFirstDoneFired,
      {
        timeout: 500,
      },
    )
  }

  private async listenEvents() {
    // Expose a function to get sent messages from Photopea
    await this.page.exposeFunction(
      "onPhotopeaMessage",
      this.handleMessage.bind(this),
    )

    // This function is used in PhotopeaChannel.evaluate()
    await this.page.exposeFunction(
      "_pp_sendResponse",
      (id: string, reqType: string, data: unknown) => {
        if (typeof id !== "string") throw new Error("Invalid requestId type")
        if (typeof reqType !== "string") throw new Error("Invalid reqType type")
        this.emit("response", id, reqType, data)
      },
    )

    this.page.on("console", (msg) => {
      // Ignore network noise (e.g. blocked/missing subresources in offline
      // mode surface as "Failed to load resource: net::ERR_*"). These must
      // not abort script evaluation via "pageerror".
      if (msg.text().startsWith("Failed to load resource:")) return
      if (msg.type() === "error" || msg.text().includes("Error")) {
        this.emit("pageerror", new Error(msg.text()))
      }
    })

    this.page.on("pageerror", (msg) => {
      this.emit("pageerror", msg)
    })
  }

  /**
   * Closes the underlying Playwright page.
   * @returns Promise that resolves when the page is closed.
   */
  close() {
    return this.page.close()
  }

  async sendMessage(message: string | ArrayBuffer) {
    return await this.page.evaluate((msg) => {
      const transferList = msg instanceof ArrayBuffer ? [msg] : undefined
      window.postMessage(msg, "https://www.photopea.com", transferList)
    }, message)
  }

  [Symbol.asyncDispose]() {
    return this.close()
  }
}
