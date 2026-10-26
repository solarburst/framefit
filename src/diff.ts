import { mkdirSync } from "node:fs"
import path from "node:path"
import type { PNG } from "pngjs"
import { StartupError, errorMessage } from "./errors.js"
import { cropPng, diffImage, ignoreMask, paintIgnore, pixelDiff, readPng, regionsFromMask, writePng } from "./png.js"
import type { IgnoreRect, Rect, ReportedRegion, TextBox, VisualReport } from "./types.js"

const COLOR_THRESHOLD = 0.1
const REGION_LIMIT = 40

export const DEFAULT_REGION_GATE = { minPixels: 60, density: 0.2 }

export async function compareShots(options: {
  referencePath: string
  actualPath: string
  outDir: string
  ignore: IgnoreRect[]
  threshold: number
  inkThreshold?: number
  scale?: number
  shift?: number
  allowSizeMismatch?: boolean
  regionGate?: { minPixels: number; density: number }
  texts?: TextBox[]
}): Promise<VisualReport> {
  const scale = options.scale ?? 1
  const inkThreshold = options.inkThreshold ?? 0.1
  const gate = options.regionGate ?? DEFAULT_REGION_GATE
  let reference: PNG
  let actual: PNG
  try {
    reference = readPng(options.referencePath)
    actual = readPng(options.actualPath)
  } catch (error) {
    throw new StartupError(`Не удалось прочитать PNG: ${errorMessage(error)}`)
  }

  mkdirSync(options.outDir, { recursive: true })
  const actualPath = path.join(options.outDir, "actual.png")
  if (path.resolve(options.actualPath) !== path.resolve(actualPath)) writePng(actualPath, actual)

  const sameSize = reference.width === actual.width && reference.height === actual.height
  const base = {
    threshold: options.threshold,
    inkThreshold,
    regionGate: gate,
    actual: actualPath,
  }
  const sizeMessage = `Размер эталона ${reference.width}x${reference.height} не совпал со скриншотом ${actual.width}x${actual.height}`
  if (!sameSize && !options.allowSizeMismatch) {
    return {
      ...base,
      pass: false,
      mismatchRatio: 1,
      inkMismatchRatio: 1,
      failingRegions: 0,
      diffCount: reference.width * reference.height,
      sizeMismatch: true,
      message: sizeMessage,
      regions: [],
    }
  }

  const width = Math.min(reference.width, actual.width)
  const height = Math.min(reference.height, actual.height)
  const outsideCommon = Math.max(reference.width, actual.width) * Math.max(reference.height, actual.height) - width * height
  const ref = paintIgnore(cropPng(reference, width, height), options.ignore, scale)
  const act = paintIgnore(cropPng(actual, width, height), options.ignore, scale)
  const result = pixelDiff(ref, act, {
    colorThreshold: COLOR_THRESHOLD,
    shift: options.shift ?? scale,
    ignore: ignoreMask(width, height, options.ignore, scale),
  })

  const diffPath = path.join(options.outDir, "diff.png")
  writePng(diffPath, diffImage(ref, result.mask))

  const diffCount = result.diffCount + outsideCommon
  const total = result.comparedCount + outsideCommon
  const mismatchRatio = total === 0 ? 0 : diffCount / total
  const inkMismatchRatio = result.inkCount === 0 ? 0 : result.inkDiffCount / result.inkCount
  const minPixels = gate.minPixels * scale * scale
  const regions: ReportedRegion[] = regionsFromMask(result.mask, width, height).map((region) => {
    const css = {
      x: round(region.x / scale),
      y: round(region.y / scale),
      width: round(region.width / scale),
      height: round(region.height / scale),
    }
    const inkDensity = region.count / Math.max(region.count, countIn(result.ink, width, region))
    return {
      ...css,
      mismatch: region.mismatch,
      inkDensity,
      pixels: region.count,
      failing: region.count >= minPixels && inkDensity >= gate.density,
      elements: elementsIn(css, options.texts ?? []),
    }
  })
  const failingRegions = regions.filter((region) => region.failing).length
  const pass = sameSize
    && mismatchRatio <= options.threshold
    && inkMismatchRatio <= inkThreshold
    && failingRegions === 0

  return {
    ...base,
    pass,
    mismatchRatio,
    inkMismatchRatio,
    failingRegions,
    diffCount,
    sizeMismatch: false,
    ...(sameSize ? {} : { message: `${sizeMessage}. Сравнена общая часть, остальное считается расхождением` }),
    regions: regions.filter((region, index) => index < REGION_LIMIT || region.failing),
    diff: diffPath,
  }
}

const TEXT_COVERAGE = 0.8
const TEXT_MARGIN = 2

/**
 * Dense regions that sit on strings the geometry check accepted are glyph rasterisation
 * differences (Figma vs Chrome, font builds), so they stop failing the visual gate.
 */
export function forgiveTextRegions(visual: VisualReport, matched: Rect[]): VisualReport {
  if (visual.sizeMismatch || matched.length === 0) return visual
  const regions = visual.regions.map((region) => {
    if (!region.failing || coverage(region, matched) < TEXT_COVERAGE) return region
    return { ...region, failing: false, textNoise: true }
  })
  const failingRegions = regions.filter((region) => region.failing).length
  const pass = visual.mismatchRatio <= visual.threshold
    && visual.inkMismatchRatio <= visual.inkThreshold
    && failingRegions === 0
    && !visual.message
  return { ...visual, regions, failingRegions, pass }
}

function coverage(region: Rect, rects: Rect[]): number {
  let covered = 0
  let total = 0
  for (let y = Math.floor(region.y); y < region.y + region.height; y++) {
    for (let x = Math.floor(region.x); x < region.x + region.width; x++) {
      total++
      if (rects.some((rect) =>
        x >= rect.x - TEXT_MARGIN && x < rect.x + rect.width + TEXT_MARGIN &&
        y >= rect.y - TEXT_MARGIN && y < rect.y + rect.height + TEXT_MARGIN)) covered++
    }
  }
  return total === 0 ? 0 : covered / total
}

function countIn(mask: Uint8Array, width: number, rect: Rect): number {
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) if (mask[y * width + x] === 2) count++
  }
  return count
}

function elementsIn(region: Rect, texts: TextBox[]): string[] {
  const hits: Array<{ label: string; area: number }> = []
  for (const text of texts) {
    if (!text.leaf) continue
    const width = Math.min(region.x + region.width, text.rect.x + text.rect.width) - Math.max(region.x, text.rect.x)
    const height = Math.min(region.y + region.height, text.rect.y + text.rect.height) - Math.max(region.y, text.rect.y)
    if (width <= 0 || height <= 0) continue
    hits.push({ label: `${text.selector} «${truncate(text.text, 40)}»`, area: width * height })
  }
  hits.sort((a, b) => b.area - a.area)
  return hits.slice(0, 4).map((hit) => hit.label)
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
