import { readFileSync } from "node:fs"
import path from "node:path"
import { StartupError } from "./errors.js"
import type { AssetFixture, Fixture, IgnoreRect, RouteFixture } from "./types.js"

export type CompiledRoute = {
  kind: "route"
  method: string
  url: string
  status: number
  contentType: string
  body: string
  hits: number
}

export type CompiledAsset = {
  kind: "asset"
  url: string
  file: string
  contentType: string
  body: Buffer
  hits: number
}

export type LoadedFixture = {
  ignore: IgnoreRect[]
  routes: CompiledRoute[]
  assets: CompiledAsset[]
  directory: string
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
}

export function loadFixture(fixturePath: string): LoadedFixture {
  const absolute = path.resolve(fixturePath)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"))
  } catch (error) {
    throw new StartupError(`Не удалось прочитать фикстуру ${absolute}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StartupError(`Фикстура ${absolute} должна быть JSON-объектом`)
  }
  const fixture = raw as Fixture
  const directory = path.dirname(absolute)
  const ignore = (fixture.ignore ?? []).map((rect, index) => parseRect(rect, index))
  const routes = (fixture.routes ?? []).map((route, index) => compileRoute(route, index))
  const assets = (fixture.assets ?? []).map((asset, index) => compileAsset(asset, index, directory))
  return { ignore, routes, assets, directory }
}

export function globToRegExp(glob: string): RegExp {
  let source = ""
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    const next = glob[i + 1]
    if (char === "*" && next === "*") {
      source += ".*"
      i++
      if (glob[i + 1] === "/") i++
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      continue
    }
    if ("\\^$+?.()|{}[]".includes(char)) {
      source += `\\${char}`
      continue
    }
    source += char
  }
  return new RegExp(`^${source}$`)
}

export function urlMatches(pattern: string, url: string): boolean {
  const expression = globToRegExp(pattern)
  if (expression.test(url)) return true
  const withoutQuery = url.split("?")[0] ?? url
  return expression.test(withoutQuery)
}

function parseRect(rect: IgnoreRect, index: number): IgnoreRect {
  const values = [rect?.x, rect?.y, rect?.width, rect?.height]
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new StartupError(`ignore[${index}] должен содержать числа x, y, width, height`)
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function compileRoute(route: RouteFixture, index: number): CompiledRoute {
  if (!route || typeof route.url !== "string" || route.url.length === 0) {
    throw new StartupError(`routes[${index}].url обязателен`)
  }
  const hasBody = typeof route.body === "string"
  const hasJson = "json" in route
  if (!hasBody && !hasJson) {
    throw new StartupError(`routes[${index}] должен содержать json или body`)
  }
  return {
    kind: "route",
    method: (route.method ?? "GET").toUpperCase(),
    url: route.url,
    status: route.status ?? 200,
    contentType: route.contentType ?? (hasBody ? "text/plain; charset=utf-8" : "application/json"),
    body: hasBody ? route.body! : JSON.stringify(route.json ?? null),
    hits: 0,
  }
}

function compileAsset(asset: AssetFixture, index: number, directory: string): CompiledAsset {
  if (!asset || typeof asset.url !== "string" || asset.url.length === 0) {
    throw new StartupError(`assets[${index}].url обязателен`)
  }
  if (typeof asset.file !== "string" || asset.file.length === 0) {
    throw new StartupError(`assets[${index}].file обязателен`)
  }
  const file = path.resolve(directory, asset.file)
  let body: Buffer
  try {
    body = readFileSync(file)
  } catch (error) {
    throw new StartupError(`Не удалось прочитать ассет ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const extension = path.extname(file).toLowerCase()
  return {
    kind: "asset",
    url: asset.url,
    file,
    contentType: MIME[extension] ?? "application/octet-stream",
    body,
    hits: 0,
  }
}
