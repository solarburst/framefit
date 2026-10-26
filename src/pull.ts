import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PNG } from "pngjs"
import { StartupError, errorMessage } from "./errors.js"
import type { Design, DesignText } from "./types.js"

const API = "https://api.figma.com/v1"

type FigmaBox = { x: number; y: number; width: number; height: number }

type FigmaPaint = {
  type: string
  visible?: boolean
  opacity?: number
  color?: { r: number; g: number; b: number; a: number }
}

export type FigmaNode = {
  id: string
  name?: string
  type: string
  visible?: boolean
  opacity?: number
  characters?: string
  style?: {
    fontFamily?: string
    fontWeight?: number
    fontSize?: number
    lineHeightPx?: number
    lineHeightUnit?: string
  }
  fills?: FigmaPaint[]
  absoluteBoundingBox?: FigmaBox | null
  absoluteRenderBounds?: FigmaBox | null
  children?: FigmaNode[]
}

export function parseFigmaUrl(value: string): { fileKey: string; nodeId: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new StartupError(`Не похоже на ссылку Figma: ${value}`)
  }
  const parts = url.pathname.split("/").filter(Boolean)
  const kind = parts[0]
  if (!kind || !["design", "file", "proto"].includes(kind) || !parts[1]) {
    throw new StartupError(`Ожидалась ссылка вида figma.com/design/<key>/...: ${value}`)
  }
  const fileKey = parts[2] === "branch" && parts[3] ? parts[3] : parts[1]
  const rawNode = url.searchParams.get("node-id")
  if (!rawNode) throw new StartupError("В ссылке нет node-id: нужна ссылка на конкретный фрейм")
  return { fileKey, nodeId: decodeURIComponent(rawNode).replace(/-/g, ":") }
}

/** Frame-relative text inventory from a Figma REST node tree. */
export function designFromNode(root: FigmaNode, origin: FigmaBox, meta: { fileKey?: string; nodeId?: string } = {}): Design {
  const texts: DesignText[] = []
  const visit = (node: FigmaNode, opacity: number) => {
    if (node.visible === false) return
    const nodeOpacity = opacity * (node.opacity ?? 1)
    if (node.type === "TEXT" && node.characters?.trim() && node.absoluteBoundingBox) {
      const box = node.absoluteBoundingBox
      const x = box.x - origin.x
      const y = box.y - origin.y
      const inside = x + box.width > 0 && y + box.height > 0 && x < origin.width && y < origin.height
      if (inside) {
        const style = node.style ?? {}
        const color = solidColor(node.fills, nodeOpacity)
        texts.push({
          id: node.id,
          ...(node.name ? { name: node.name } : {}),
          text: node.characters,
          x: round(x),
          y: round(y),
          width: round(box.width),
          height: round(box.height),
          ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
          ...(style.fontWeight ? { fontWeight: style.fontWeight } : {}),
          ...(style.fontSize ? { fontSize: style.fontSize } : {}),
          ...(style.lineHeightPx && style.lineHeightUnit !== "INTRINSIC_%" ? { lineHeight: round(style.lineHeightPx) } : {}),
          ...(color ? { color } : {}),
        })
      }
    }
    for (const child of node.children ?? []) visit(child, nodeOpacity)
  }
  visit(root, 1)
  return {
    source: "figma-rest",
    ...meta,
    frame: { width: Math.round(origin.width), height: Math.round(origin.height) },
    fonts: [...new Set(texts.map((text) => text.fontFamily).filter((family): family is string => Boolean(family)))],
    texts,
  }
}

/** Export bounds are the render bounds when they include effects, otherwise the frame box. */
export function exportOrigin(root: FigmaNode, png: { width: number; height: number }, scale: number): FigmaBox {
  const candidates = [root.absoluteBoundingBox, root.absoluteRenderBounds].filter((box): box is FigmaBox => Boolean(box))
  const exact = candidates.find(
    (box) => Math.abs(box.width * scale - png.width) <= 1 && Math.abs(box.height * scale - png.height) <= 1,
  )
  const chosen = exact ?? candidates[0]
  if (!chosen) throw new StartupError("У узла нет absoluteBoundingBox: это не фрейм на канвасе")
  return chosen
}

export async function runPull(options: { figmaUrl: string; outDir: string; token: string }): Promise<string[]> {
  const { fileKey, nodeId } = parseFigmaUrl(options.figmaUrl)
  mkdirSync(options.outDir, { recursive: true })
  const nodes = await api<{ nodes: Record<string, { document: FigmaNode } | null> }>(
    `/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
    options.token,
  )
  const root = nodes.nodes[nodeId]?.document
  if (!root) throw new StartupError(`Узел ${nodeId} не найден в файле ${fileKey}`)

  const written: string[] = []
  let origin: FigmaBox | undefined
  for (const scale of [1, 2]) {
    const images = await api<{ err: string | null; images: Record<string, string | null> }>(
      `/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`,
      options.token,
    )
    const link = images.images[nodeId]
    if (images.err || !link) throw new StartupError(`Figma не отдала PNG для ${nodeId}: ${images.err ?? "пустой ответ"}`)
    const response = await fetch(link)
    if (!response.ok) throw new StartupError(`Не удалось скачать PNG: HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const png = PNG.sync.read(buffer)
    const file = path.join(options.outDir, scale === 1 ? "reference.png" : `reference@${scale}x.png`)
    writeFileSync(file, buffer)
    written.push(file)
    if (scale === 1) origin = exportOrigin(root, png, 1)
  }

  const design = designFromNode(root, origin!, { fileKey, nodeId })
  const designPath = path.join(options.outDir, "design.json")
  writeFileSync(designPath, `${JSON.stringify(design, null, 2)}\n`)
  written.push(designPath)

  const draftPath = path.join(options.outDir, "fixture.draft.json")
  const draft = {
    ignore: [],
    routes: [],
    assets: [],
    strings: design.texts.map((text) => text.text),
  }
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`)
  written.push(draftPath)
  return written
}

async function api<T>(pathname: string, token: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API}${pathname}`, { headers: { "X-Figma-Token": token } })
  } catch (error) {
    throw new StartupError(`Figma API недоступен: ${errorMessage(error)}`)
  }
  if (response.status === 403) throw new StartupError("Figma API: 403, у токена нет доступа к файлу или токен неверный")
  if (response.status === 404) throw new StartupError("Figma API: 404, файл не найден")
  if (response.status === 429) throw new StartupError("Figma API: 429, превышен лимит запросов, повторите позже")
  if (!response.ok) throw new StartupError(`Figma API: HTTP ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

function solidColor(fills: FigmaPaint[] | undefined, opacity: number): string | undefined {
  const visible = (fills ?? []).filter((fill) => fill.visible !== false)
  if (visible.length !== 1) return undefined
  const fill = visible[0]!
  if (fill.type !== "SOLID" || !fill.color) return undefined
  const alpha = (fill.opacity ?? 1) * (fill.color.a ?? 1) * opacity
  if (alpha < 0.99) return undefined
  const hex = [fill.color.r, fill.color.g, fill.color.b]
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")
  return `#${hex}`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
