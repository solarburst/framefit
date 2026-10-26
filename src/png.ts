import { readFileSync, writeFileSync } from "node:fs"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"
import type { IgnoreRect, Region } from "./types.js"

const MASK = 0
const MAX_YIQ_DELTA = 35215
/** YIQ distance under which two colours count as the same, for edges and the shift check. */
const NEAR_COLOR = 0.1

export function readPng(file: string): PNG {
  return PNG.sync.read(readFileSync(file))
}

export function writePng(file: string, png: PNG): void {
  writeFileSync(file, PNG.sync.write(png))
}

export function paintIgnore(png: PNG, rects: IgnoreRect[], scale = 1): PNG {
  const copy = new PNG({ width: png.width, height: png.height })
  png.data.copy(copy.data)
  forEachRectPixel(copy.width, copy.height, rects, scale, (index) => {
    const offset = index << 2
    copy.data[offset] = MASK
    copy.data[offset + 1] = MASK
    copy.data[offset + 2] = MASK
    copy.data[offset + 3] = 255
  })
  return copy
}

export function ignoreMask(width: number, height: number, rects: IgnoreRect[], scale = 1): Uint8Array {
  const mask = new Uint8Array(width * height)
  forEachRectPixel(width, height, rects, scale, (index) => {
    mask[index] = 1
  })
  return mask
}

function forEachRectPixel(
  width: number,
  height: number,
  rects: IgnoreRect[],
  scale: number,
  visit: (index: number) => void,
): void {
  for (const rect of rects) {
    const x0 = clamp(Math.floor(rect.x * scale), 0, width)
    const y0 = clamp(Math.floor(rect.y * scale), 0, height)
    const x1 = clamp(Math.ceil((rect.x + rect.width) * scale), 0, width)
    const y1 = clamp(Math.ceil((rect.y + rect.height) * scale), 0, height)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) visit(width * y + x)
    }
  }
}

export function cropPng(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png
  const copy = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    png.data.copy(copy.data, y * width * 4, y * png.width * 4, y * png.width * 4 + width * 4)
  }
  return copy
}

type Yiq = { y: Float32Array; i: Float32Array; q: Float32Array }

function toYiq(png: PNG): Yiq {
  const size = png.width * png.height
  const y = new Float32Array(size)
  const i = new Float32Array(size)
  const q = new Float32Array(size)
  for (let index = 0; index < size; index++) {
    const offset = index << 2
    const alpha = png.data[offset + 3]! / 255
    const r = 255 + (png.data[offset]! - 255) * alpha
    const g = 255 + (png.data[offset + 1]! - 255) * alpha
    const b = 255 + (png.data[offset + 2]! - 255) * alpha
    y[index] = r * 0.29889531 + g * 0.58662247 + b * 0.11448223
    i[index] = r * 0.59597799 - g * 0.2741761 - b * 0.32180189
    q[index] = r * 0.21147017 - g * 0.52261711 + b * 0.31114694
  }
  return { y, i, q }
}

function delta(a: Yiq, ai: number, b: Yiq, bi: number): number {
  const dy = a.y[ai]! - b.y[bi]!
  const di = a.i[ai]! - b.i[bi]!
  const dq = a.q[ai]! - b.q[bi]!
  return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq
}

export type PixelDiff = {
  mask: Uint8Array
  /** 2 — edge in the reference, 1 — edge only in the actual image. */
  ink: Uint8Array
  diffCount: number
  inkCount: number
  inkDiffCount: number
  comparedCount: number
}

/**
 * pixelmatch decides which pixels differ and drops antialiasing. On top of that a differing
 * pixel is forgiven when each image has the other's colour within `shift` pixels.
 */
export function pixelDiff(
  reference: PNG,
  actual: PNG,
  options: { colorThreshold: number; shift: number; ignore?: Uint8Array },
): PixelDiff {
  const width = reference.width
  const height = reference.height
  const size = width * height
  const maxDelta = MAX_YIQ_DELTA * NEAR_COLOR * NEAR_COLOR
  const ref = toYiq(reference)
  const act = toYiq(actual)
  const mask = new Uint8Array(size)
  const ink = new Uint8Array(size)
  const shift = Math.max(0, Math.floor(options.shift))
  let diffCount = 0
  let inkCount = 0
  let inkDiffCount = 0
  let comparedCount = 0

  const matched = new Uint8Array(size * 4)
  pixelmatch(reference.data, actual.data, matched, width, height, {
    threshold: options.colorThreshold,
    includeAA: false,
    diffMask: true,
    diffColor: [255, 0, 0],
    aaColor: [0, 255, 0],
    checkerboard: false,
    ...(options.ignore ? { ignoreMask: options.ignore } : {}),
  })
  const differs = (index: number) => {
    const offset = index << 2
    return matched[offset + 3]! > 0 && matched[offset]! === 255 && matched[offset + 1]! === 0
  }

  const isEdge = (image: Yiq, x: number, y: number, index: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy
      if (ny < 0 || ny >= height) continue
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue
        if (delta(image, index, image, ny * width + nx) > maxDelta) return true
      }
    }
    return false
  }

  const nearby = (source: Yiq, sourceIndex: number, target: Yiq, x: number, y: number): boolean => {
    if (shift === 0) return false
    for (let dy = -shift; dy <= shift; dy++) {
      const ny = y + dy
      if (ny < 0 || ny >= height) continue
      for (let dx = -shift; dx <= shift; dx++) {
        const nx = x + dx
        if (nx < 0 || nx >= width) continue
        if (delta(source, sourceIndex, target, ny * width + nx) <= maxDelta) return true
      }
    }
    return false
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (options.ignore?.[index]) continue
      comparedCount++
      const refEdge = isEdge(ref, x, y, index)
      const onInk = refEdge || isEdge(act, x, y, index)
      if (onInk) {
        ink[index] = refEdge ? 2 : 1
        inkCount++
      }
      if (!differs(index)) continue
      if (nearby(ref, index, act, x, y) && nearby(act, index, ref, x, y)) continue
      mask[index] = 1
      diffCount++
      if (onInk) inkDiffCount++
    }
  }
  return { mask, ink, diffCount, inkCount, inkDiffCount, comparedCount }
}

export function diffImage(reference: PNG, mask: Uint8Array): PNG {
  const out = new PNG({ width: reference.width, height: reference.height })
  for (let index = 0; index < mask.length; index++) {
    const offset = index << 2
    if (mask[index]) {
      out.data[offset] = 0xff
      out.data[offset + 1] = 0x2d
      out.data[offset + 2] = 0x55
    } else {
      const alpha = reference.data[offset + 3]! / 255
      const r = 255 + (reference.data[offset]! - 255) * alpha
      const g = 255 + (reference.data[offset + 1]! - 255) * alpha
      const b = 255 + (reference.data[offset + 2]! - 255) * alpha
      const gray = 255 - (255 - (r * 0.299 + g * 0.587 + b * 0.114)) * 0.35
      out.data[offset] = gray
      out.data[offset + 1] = gray
      out.data[offset + 2] = gray
    }
    out.data[offset + 3] = 255
  }
  return out
}

export type CountedRegion = Region & { count: number }

export function regionsFromMask(diff: Uint8Array, width: number, height: number, gap = 8): CountedRegion[] {
  const labels = new Int32Array(diff.length)
  const parent = [0]
  let next = 0

  const find = (id: number): number => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]!]!
      id = parent[id]!
    }
    return id
  }
  const unite = (left: number, right: number) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (!diff[index]) continue
      const left = x > 0 && diff[index - 1] ? labels[index - 1]! : 0
      const up = y > 0 && diff[index - width] ? labels[index - width]! : 0
      if (left && up) {
        labels[index] = left
        unite(left, up)
      } else if (left || up) {
        labels[index] = left || up
      } else {
        next++
        parent[next] = next
        labels[index] = next
      }
    }
  }

  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; count: number }>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = labels[y * width + x]
      if (!label) continue
      const id = find(label)
      const box = boxes.get(id)
      if (!box) {
        boxes.set(id, { x0: x, y0: y, x1: x, y1: y, count: 1 })
        continue
      }
      box.x0 = Math.min(box.x0, x)
      box.y0 = Math.min(box.y0, y)
      box.x1 = Math.max(box.x1, x)
      box.y1 = Math.max(box.y1, y)
      box.count++
    }
  }

  const regions: CountedRegion[] = [...boxes.values()].map((box) => {
    const regionWidth = box.x1 - box.x0 + 1
    const regionHeight = box.y1 - box.y0 + 1
    return {
      x: box.x0,
      y: box.y0,
      width: regionWidth,
      height: regionHeight,
      count: box.count,
      mismatch: box.count / (regionWidth * regionHeight),
    }
  })
  const merged = mergeClose(regions, gap)
  merged.sort((a, b) => b.count - a.count || b.mismatch - a.mismatch)
  return merged
}

export function mergeClose(regions: CountedRegion[], gapLimit: number): CountedRegion[] {
  const items = regions.slice()
  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (rectGap(items[i]!, items[j]!) >= gapLimit) continue
        items[i] = unionRect(items[i]!, items[j]!)
        items.splice(j, 1)
        merged = true
        break
      }
      if (merged) break
    }
  }
  return items
}

function unionRect(a: CountedRegion, b: CountedRegion): CountedRegion {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  const width = right - x
  const height = bottom - y
  const count = a.count + b.count
  return { x, y, width, height, count, mismatch: count / (width * height) }
}

function rectGap(a: Region, b: Region): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height))
  return Math.max(dx, dy)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
