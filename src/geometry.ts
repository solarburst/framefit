import { readFileSync } from "node:fs"
import path from "node:path"
import type { PNG } from "pngjs"
import { StartupError, errorMessage } from "./errors.js"
import type { Design, DesignText, GeometryMatch, GeometryReport, Rect, TextBox } from "./types.js"

const INK_MARGIN = 2
const INK_CHANNEL_DELTA = 40
const COLOR_DISTANCE = 24

export function loadDesign(designPath: string): Design {
  const absolute = path.resolve(designPath)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"))
  } catch (error) {
    throw new StartupError(`Не удалось прочитать design ${absolute}: ${errorMessage(error)}`)
  }
  const design = raw as Design
  if (!design || typeof design !== "object" || !Array.isArray(design.texts)) {
    throw new StartupError(`design ${absolute} должен содержать массив texts`)
  }
  if (!design.frame || !isNumber(design.frame.width) || !isNumber(design.frame.height)) {
    throw new StartupError(`design ${absolute} должен содержать frame.width и frame.height`)
  }
  design.texts.forEach((text, index) => {
    if (typeof text?.text !== "string" || ![text.x, text.y, text.width, text.height].every(isNumber)) {
      throw new StartupError(`design.texts[${index}] должен содержать text, x, y, width, height`)
    }
  })
  return design
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[\s\u00a0\u200b\u2028]+/g, "").replace(/[…]/g, "...")
}

export function compareGeometry(options: {
  design: Design
  designPath: string
  reference: PNG
  actual: PNG
  scale: number
  texts: TextBox[]
  tolerance: number
}): GeometryReport {
  const { design, reference, actual, scale, tolerance } = options
  const groups = groupCandidates(options.texts)
  const used = new Set<TextBox>()
  const matches: GeometryMatch[] = []
  const missing: string[] = []

  for (const text of design.texts) {
    const key = normalizeText(text.text)
    if (!key) continue
    const candidates = groups.filter((box) => !used.has(box) && normalizeText(box.text) === key)
    if (candidates.length === 0) {
      missing.push(text.text)
      continue
    }
    const center = { x: text.x + text.width / 2, y: text.y + text.height / 2 }
    candidates.sort((a, b) => distance(center, a.rect) - distance(center, b.rect))
    const box = candidates[0]!
    used.add(box)
    matches.push(matchOne(text, box, reference, actual, scale, tolerance))
  }

  const designKeys = design.texts
    .map((text) => normalizeText(text.text))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const extra = options.texts
    .filter((box) => box.leaf)
    .filter((box) => {
      const key = normalizeText(box.text)
      if (!key || designKeys.some((designKey) => designKey.includes(key))) return false
      const rest = designKeys.reduce((left, designKey) => left.split(designKey).join(""), key)
      return rest.length > 0
    })
    .map((box) => box.text)

  return {
    pass: missing.length === 0 && matches.every((match) => match.pass),
    design: path.resolve(options.designPath),
    tolerance,
    matches,
    missing,
    extra: [...new Set(extra)].slice(0, 30),
  }
}

function matchOne(
  text: DesignText,
  box: TextBox,
  reference: PNG,
  actual: PNG,
  scale: number,
  tolerance: number,
): GeometryMatch {
  const problems: string[] = []
  const expected = inkBox(reference, text, scale)
  const got = inkBox(actual, box.rect, scale)
  let dx: number | null = null
  let dy: number | null = null
  let dw: number | null = null
  let dh: number | null = null
  if (!expected) problems.push("на эталоне в боксе слоя нет текста, проверьте координаты в design")
  if (!got) problems.push("на скриншоте текст не виден")
  if (expected && got) {
    dx = round(got.x - expected.x)
    dy = round(got.y - expected.y)
    dw = round(got.width - expected.width)
    dh = round(got.height - expected.height)
    const sizeTolerance = (size: number) => Math.max(tolerance + 1, size * 0.02)
    if (Math.abs(dx) > tolerance) problems.push(`сдвиг по x ${signed(dx)}px`)
    if (Math.abs(dy) > tolerance) problems.push(`сдвиг по y ${signed(dy)}px`)
    if (Math.abs(dw) > sizeTolerance(expected.width)) problems.push(`ширина ${signed(dw)}px`)
    if (Math.abs(dh) > sizeTolerance(expected.height)) problems.push(`высота ${signed(dh)}px (переносы или line-height)`)
  }
  if (text.fontFamily && text.fontFamily.toLowerCase() !== box.fontFamily.toLowerCase()) {
    problems.push(`шрифт ${box.fontFamily}, в макете ${text.fontFamily}`)
  }
  if (isNumber(text.fontWeight) && text.fontWeight !== box.fontWeight) {
    problems.push(`вес ${box.fontWeight}, в макете ${text.fontWeight}`)
  }
  if (isNumber(text.fontSize) && Math.abs(text.fontSize - box.fontSize) > 0.5) {
    problems.push(`размер ${box.fontSize}px, в макете ${text.fontSize}px`)
  }
  if (isNumber(text.lineHeight) && box.lineHeight !== null && Math.abs(text.lineHeight - box.lineHeight) > 0.5) {
    problems.push(`line-height ${box.lineHeight}px, в макете ${text.lineHeight}px`)
  }
  if (text.color && colorDistance(text.color, box.color) > COLOR_DISTANCE) {
    problems.push(`цвет ${box.color}, в макете ${text.color}`)
  }
  return { text: text.text, selector: box.selector, rect: box.rect, pass: problems.length === 0, dx, dy, dw, dh, problems }
}

/** Identical boxes (a <p> wrapping a single <span>) collapse into the deepest element. */
function groupCandidates(texts: TextBox[]): TextBox[] {
  const result: TextBox[] = []
  for (const box of texts) {
    const index = result.findIndex(
      (other) => normalizeText(other.text) === normalizeText(box.text) && sameRect(other.rect, box.rect),
    )
    if (index >= 0) result[index] = box
    else result.push(box)
  }
  return result
}

/** Tight box of pixels that differ from the dominant colour of the rect border, in CSS px. */
export function inkBox(png: PNG, rect: Rect, scale: number): Rect | null {
  const x0 = clamp(Math.floor((rect.x - INK_MARGIN) * scale), 0, png.width - 1)
  const y0 = clamp(Math.floor((rect.y - INK_MARGIN) * scale), 0, png.height - 1)
  const x1 = clamp(Math.ceil((rect.x + rect.width + INK_MARGIN) * scale), 0, png.width - 1)
  const y1 = clamp(Math.ceil((rect.y + rect.height + INK_MARGIN) * scale), 0, png.height - 1)
  if (x1 <= x0 || y1 <= y0) return null
  const counts = new Map<number, { count: number; rgb: [number, number, number] }>()
  const pixel = (x: number, y: number): [number, number, number] => {
    const offset = (y * png.width + x) << 2
    const alpha = png.data[offset + 3]! / 255
    return [0, 1, 2].map((channel) => 255 + (png.data[offset + channel]! - 255) * alpha) as [number, number, number]
  }
  const vote = (x: number, y: number) => {
    const rgb = pixel(x, y)
    const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3)
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { count: 1, rgb })
  }
  for (let x = x0; x <= x1; x++) {
    vote(x, y0)
    vote(x, y1)
  }
  for (let y = y0 + 1; y < y1; y++) {
    vote(x0, y)
    vote(x1, y)
  }
  const background = [...counts.values()].sort((a, b) => b.count - a.count)[0]!.rgb
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const rgb = pixel(x, y)
      const diff = Math.max(
        Math.abs(rgb[0] - background[0]),
        Math.abs(rgb[1] - background[1]),
        Math.abs(rgb[2] - background[2]),
      )
      if (diff < INK_CHANNEL_DELTA) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (!Number.isFinite(left)) return null
  return {
    x: left / scale,
    y: top / scale,
    width: (right - left + 1) / scale,
    height: (bottom - top + 1) / scale,
  }
}

export function colorDistance(first: string, second: string): number {
  const a = parseHex(first)
  const b = parseHex(second)
  if (!a || !b) return 0
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function parseHex(color: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})/i.exec(color.trim())
  if (!match) return null
  const value = parseInt(match[1]!, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
}

function distance(point: { x: number; y: number }, rect: Rect): number {
  return Math.hypot(point.x - (rect.x + rect.width / 2), point.y - (rect.y + rect.height / 2))
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
