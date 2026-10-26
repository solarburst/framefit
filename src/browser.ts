import path from "node:path"
import { chromium, type Browser, type Page, type Request } from "playwright"
import { StartupError, errorMessage } from "./errors.js"
import type { CompiledAsset, CompiledRoute, LoadedFixture } from "./fixture.js"
import { urlMatches } from "./fixture.js"
import type { NetworkReport, NetworkRequest, Viewport } from "./types.js"

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
}

export type NetworkLedger = {
  snapshot(): NetworkReport
}

const FREEZE_CSS = `*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}`

export async function withPage<T>(options: {
  url: string
  viewport: Viewport
  scale?: number
  selector?: string
  fixture: LoadedFixture
  run: (page: Page, network: NetworkLedger) => Promise<T>
}): Promise<T> {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor: options.scale ?? 1,
      reducedMotion: "reduce",
    })
    const page = await context.newPage()
    const client = await context.newCDPSession(page)
    await client.send("Network.setCacheDisabled", { cacheDisabled: true })
    const network = await attachRoutes(page, options.fixture)
    try {
      await page.goto(options.url, { waitUntil: "load", timeout: 30_000 })
    } catch (error) {
      throw new StartupError(`Не удалось открыть ${options.url}: ${errorMessage(error)}`)
    }
    try {
      // Vite держит websocket, поэтому networkidle ограничен по времени.
      await page.waitForLoadState("networkidle", { timeout: 5_000 })
    } catch {
      // load уже дождались, шрифты ждём ниже.
    }
    await page.addStyleTag({ content: FREEZE_CSS })
    if (options.selector) {
      try {
        await page.locator(options.selector).first().waitFor({ state: "visible", timeout: 10_000 })
      } catch {
        throw new StartupError(`На странице нет видимого элемента ${options.selector}`)
      }
    }
    await settle(page)
    return await options.run(page, network)
  } finally {
    await browser.close()
  }
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    await document.fonts.ready
  })
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    return await chromium.launch({ headless: true, channel: "chrome" })
  }
}

export async function takeScreenshot(page: Page, file: string, selector?: string): Promise<void> {
  await settle(page)
  const options = { path: file, type: "png" as const, animations: "disabled" as const, caret: "hide" as const }
  if (selector) await page.locator(selector).first().screenshot(options)
  else await page.screenshot({ ...options, fullPage: false })
}

async function attachRoutes(page: Page, fixture: LoadedFixture): Promise<NetworkLedger> {
  const matched = new WeakSet<Request>()
  const watched: Array<NetworkRequest & { request: Request }> = []

  page.on("request", (request) => {
    const resourceType = request.resourceType()
    if (resourceType !== "fetch" && resourceType !== "xhr" && resourceType !== "image") return
    if (request.url().startsWith("data:")) return
    if (request.url().endsWith("/favicon.ico")) return
    watched.push({
      method: request.method(),
      url: request.url(),
      resourceType,
      request,
    })
  })

  await page.route("**/*", async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS" && matchesAny(request.url(), fixture)) {
      await route.fulfill({ status: 204, headers: CORS, body: "" })
      return
    }
    const asset = fixture.assets.find((item) => urlMatches(item.url, request.url()))
    if (asset) {
      asset.hits++
      matched.add(request)
      await route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": asset.contentType },
        body: asset.body,
      })
      return
    }
    const hit = fixture.routes.find(
      (item) => item.method === request.method().toUpperCase() && urlMatches(item.url, request.url()),
    )
    if (hit) {
      hit.hits++
      matched.add(request)
      await route.fulfill({
        status: hit.status,
        headers: { ...CORS, "content-type": hit.contentType },
        body: hit.body,
      })
      return
    }
    await route.continue()
  })

  return {
    snapshot() {
      return {
        unmatchedRequests: watched
          .filter((item) => !matched.has(item.request))
          .map(({ method, url, resourceType }) => ({ method, url, resourceType })),
        unusedRoutes: [
          ...fixture.routes.filter((route) => route.hits === 0).map(describeRoute),
          ...fixture.assets.filter((asset) => asset.hits === 0).map(describeAsset),
        ],
      }
    },
  }
}

function matchesAny(url: string, fixture: LoadedFixture): boolean {
  return fixture.routes.some((route) => urlMatches(route.url, url)) || fixture.assets.some((asset) => urlMatches(asset.url, url))
}

function describeRoute(route: CompiledRoute): string {
  return `${route.method} ${route.url}`
}

function describeAsset(asset: CompiledAsset): string {
  return `GET ${asset.url} (${path.basename(asset.file)})`
}
