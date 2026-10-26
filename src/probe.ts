import type { LayoutProbeResult } from "./types.js"

export type ProbeOptions = {
  mode: "check" | "stress"
  selector?: string
}

/** Runs in the page; must not reference anything outside its own body. */
export function probePage(options: ProbeOptions): LayoutProbeResult {
  const LIMIT = 30
  const SLOP = 2
  const GENERIC = new Set([
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
    "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "-apple-system", "blinkmacsystemfont",
  ])
  const root: Element = options.selector ? document.querySelector(options.selector)! : document.body
  const styles = new Map<Element, CSSStyleDeclaration>()
  const style = (element: Element) => {
    let cached = styles.get(element)
    if (!cached) {
      cached = getComputedStyle(element)
      styles.set(element, cached)
    }
    return cached
  }

  function isHidden(element: Element): boolean {
    let current: Element | null = element
    while (current && current !== document.body) {
      const computed = style(current)
      if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") return true
      current = current.parentElement
    }
    return false
  }

  function cssPath(element: Element): string {
    const parts: string[] = []
    let current: Element | null = element
    while (current && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase()
      if (current.id) {
        parts.unshift(`#${current.id}`)
        break
      }
      const className = typeof current.className === "string" ? current.className.trim().split(/\s+/)[0] : ""
      if (className) part += `.${className}`
      const parent: Element | null = current.parentElement
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === current!.tagName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`
      }
      parts.unshift(part)
      if (current === root) break
      current = parent
    }
    return parts.join(" > ") || element.tagName.toLowerCase()
  }

  function ancestorsInside(element: Element): Element[] {
    const chain: Element[] = []
    let current: Element | null = element
    while (current && current !== root && current !== document.body) {
      chain.push(current)
      current = current.parentElement
    }
    return chain
  }

  function firstFamily(stack: string): string {
    return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "")
  }

  function toHex(color: string): string {
    const match = /rgba?\(([^)]+)\)/.exec(color)
    if (!match) return color
    const [r, g, b] = match[1]!.split(/[\s,/]+/).map((value) => Math.round(Number(value)))
    return `#${[r, g, b].map((value) => (value ?? 0).toString(16).padStart(2, "0")).join("")}`
  }

  const origin = root === document.body ? { x: 0, y: 0 } : (() => {
    const rect = root.getBoundingClientRect()
    return { x: rect.left, y: rect.top }
  })()

  const elements = [root, ...Array.from(root.querySelectorAll("*"))]
    .filter((element) => element !== document.body && !isHidden(element))
  const truncated = (element: Element) => element.closest("[data-framefit-truncate]") !== null
  const overlay = (element: Element) => element.closest("[data-framefit-overlay]") !== null

  const page = document.documentElement
  const overflow: LayoutProbeResult["overflow"] = page.scrollWidth > page.clientWidth + SLOP
    ? [{ kind: "page-horizontal", selector: "document", scroll: page.scrollWidth, client: page.clientWidth }]
    : []

  const horizontal = elements.filter(
    (element) => !truncated(element) && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + SLOP,
  )
  const deepest = horizontal.filter(
    (element) => !horizontal.some((other) => other !== element && element.contains(other)),
  )
  for (const element of deepest.slice(0, LIMIT)) {
    overflow.push({ kind: "horizontal", selector: cssPath(element), scroll: element.scrollWidth, client: element.clientWidth })
  }

  const clippedText: LayoutProbeResult["clippedText"] = []
  for (const element of elements) {
    if (truncated(element)) continue
    if (!(element.textContent ?? "").trim()) continue
    if (element.clientHeight === 0) continue
    if (element.scrollHeight <= element.clientHeight + SLOP) continue
    const overflowY = style(element).overflowY
    if (overflowY !== "hidden" && overflowY !== "scroll" && overflowY !== "auto" && overflowY !== "clip") continue
    clippedText.push({ kind: "clipped-text", selector: cssPath(element), scroll: element.scrollHeight, client: element.clientHeight })
    if (clippedText.length >= LIMIT) break
  }

  const hasOwnText = (element: Element) =>
    Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim())

  const overlaps: LayoutProbeResult["overlaps"] = []
  if (options.mode === "stress") {
    const rects = elements
      .filter((element) => hasOwnText(element) && !overlay(element))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
    outer: for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const first = rects[i]!
        const second = rects[j]!
        if (first.element.contains(second.element) || second.element.contains(first.element)) continue
        const width = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left)
        const height = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top)
        if (width <= SLOP || height <= SLOP) continue
        overlaps.push({ a: cssPath(first.element), b: cssPath(second.element) })
        if (overlaps.length >= LIMIT) break outer
      }
    }
  }

  let absoluteTextChars = 0
  let totalTextChars = 0
  const nudges = new Map<string, LayoutProbeResult["nudged"][number]>()
  const fontChars = new Map<string, number>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || parent.closest("script, style, noscript")) continue
    if (isHidden(parent)) continue
    const length = (node.textContent ?? "").trim().length
    if (!length) continue
    totalTextChars += length
    const family = firstFamily(style(parent).fontFamily)
    fontChars.set(family, (fontChars.get(family) ?? 0) + length)
    if (overlay(parent)) continue
    const chain = ancestorsInside(parent)
    if (chain.some((element) => {
      const position = style(element).position
      return position === "absolute" || position === "fixed"
    })) {
      absoluteTextChars += length
    }
    for (const element of chain) {
      const computed = style(element)
      const found: Array<[LayoutProbeResult["nudged"][number]["kind"], string]> = []
      if (computed.position === "relative") {
        const offsets = (["top", "left", "right", "bottom"] as const)
          .filter((side) => Math.abs(parseFloat(computed[side]) || 0) >= 1)
          .map((side) => `${side}: ${computed[side]}`)
        if (offsets.length) found.push(["relative-offset", offsets.join("; ")])
      }
      const matrix = /matrix(3d)?\(([^)]+)\)/.exec(computed.transform)
      if (matrix) {
        const values = matrix[2]!.split(",").map(Number)
        const tx = matrix[1] ? values[12]! : values[4]!
        const ty = matrix[1] ? values[13]! : values[5]!
        if (Math.abs(tx) >= 1 || Math.abs(ty) >= 1) found.push(["transform", computed.transform])
      }
      if (computed.translate && computed.translate !== "none" && computed.translate.split(/\s+/).some((v) => Math.abs(parseFloat(v) || 0) >= 1)) {
        found.push(["transform", `translate: ${computed.translate}`])
      }
      const margins = (["marginTop", "marginLeft", "marginRight", "marginBottom"] as const)
        .filter((side) => (parseFloat(computed[side]) || 0) < -1)
        .map((side) => `${side}: ${computed[side]}`)
      if (margins.length) found.push(["negative-margin", margins.join("; ")])
      for (const [kind, value] of found) {
        const selector = cssPath(element)
        const key = `${kind}|${selector}`
        const existing = nudges.get(key)
        if (existing) existing.chars += length
        else nudges.set(key, { kind, selector, value, chars: length })
      }
    }
  }

  const loadedFamilies = new Set<string>()
  const declaredFamilies = new Set<string>()
  document.fonts.forEach((face) => {
    const family = face.family.replace(/^["']|["']$/g, "").toLowerCase()
    declaredFamilies.add(family)
    if (face.status === "loaded") loadedFamilies.add(family)
  })
  const canvas = document.createElement("canvas").getContext("2d")!
  const localFont = (family: string) => {
    const sample = "mmmmmmmmmmlliWWЖжй1"
    return ["monospace", "serif"].some((fallback) => {
      canvas.font = `72px ${fallback}`
      const base = canvas.measureText(sample).width
      canvas.font = `72px "${family}", ${fallback}`
      return canvas.measureText(sample).width !== base
    })
  }
  const fonts = [...fontChars.entries()].map(([family, chars]) => {
    const key = family.toLowerCase()
    const status: LayoutProbeResult["fonts"][number]["status"] = GENERIC.has(key)
      ? "generic"
      : loadedFamilies.has(key)
        ? "loaded"
        : !declaredFamilies.has(key) && localFont(family)
          ? "local"
          : "missing"
    return { family, status, chars }
  })

  const texts: LayoutProbeResult["texts"] = []
  const pushText = (target: Node, styled: Element, selector: string, leaf: boolean) => {
    const text = (target.textContent ?? "").replace(/\s+/g, " ").trim()
    if (!text) return
    const range = document.createRange()
    range.selectNodeContents(target)
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    if (!rects.length) return
    const left = Math.min(...rects.map((rect) => rect.left))
    const top = Math.min(...rects.map((rect) => rect.top))
    const right = Math.max(...rects.map((rect) => rect.right))
    const bottom = Math.max(...rects.map((rect) => rect.bottom))
    const computed = style(styled)
    texts.push({
      selector,
      text,
      leaf,
      rect: { x: left - origin.x, y: top - origin.y, width: right - left, height: bottom - top },
      fontFamily: firstFamily(computed.fontFamily),
      fontWeight: parseInt(computed.fontWeight, 10) || 400,
      fontSize: parseFloat(computed.fontSize),
      lineHeight: computed.lineHeight === "normal" ? null : parseFloat(computed.lineHeight),
      color: toHex(computed.color),
    })
  }
  for (const element of elements) {
    if (element.closest("script, style, noscript")) continue
    const firstText = (() => {
      const inner = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = inner.nextNode(); node; node = inner.nextNode()) {
        if ((node.textContent ?? "").trim() && node.parentElement) return node.parentElement
      }
      return element
    })()
    const selector = cssPath(element)
    pushText(element, firstText, selector, hasOwnText(element))
    // Figma often splits one paragraph into a layer per line; the DOM keeps it as text nodes split by <br>.
    const ownTexts = Array.from(element.childNodes).filter(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim(),
    )
    if (ownTexts.length > 1) {
      ownTexts.forEach((node, index) => pushText(node, element, `${selector} (строка ${index + 1})`, false))
    }
  }

  return {
    overflow,
    clippedText,
    overlaps,
    nudged: [...nudges.values()].slice(0, LIMIT),
    absoluteTextChars,
    totalTextChars,
    fonts,
    texts,
    origin,
  }
}

/** Runs in the page. Remembers original strings so later phases can restore them. */
export function rewriteLeafText(options: { selector?: string; mode: "elongate" | "shorten" }): void {
  const root: Element = options.selector ? document.querySelector(options.selector)! : document.body
  const store = window as unknown as { __framefitOriginal?: WeakMap<Text, string> }
  const originals = (store.__framefitOriginal ??= new WeakMap<Text, string>())
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  for (const textNode of nodes) {
    const parent = textNode.parentElement
    if (!parent || parent.closest("script, style, noscript")) continue
    const original = originals.get(textNode) ?? textNode.textContent ?? ""
    const trimmed = original.trim()
    if (!trimmed) continue
    originals.set(textNode, original)
    textNode.textContent = options.mode === "elongate" ? `${trimmed} ${trimmed}` : Array.from(trimmed)[0]!
  }
}

/** Runs in the page. Sizes of leaf text elements keyed by a stable marker attribute. */
export function measureLeaves(options: { selector?: string }): Array<{ id: string; selector: string; width: number; height: number }> {
  const root: Element = options.selector ? document.querySelector(options.selector)! : document.body
  const result: Array<{ id: string; selector: string; width: number; height: number }> = []
  let next = 0
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (element.closest("script, style, noscript")) continue
    const own = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim())
    if (!own) continue
    const computed = getComputedStyle(element)
    if (computed.display === "none" || computed.visibility === "hidden") continue
    let id = element.getAttribute("data-framefit-leaf")
    if (!id) {
      id = String(next++)
      element.setAttribute("data-framefit-leaf", id)
    } else {
      next = Math.max(next, Number(id) + 1)
    }
    const rect = element.getBoundingClientRect()
    const tag = element.tagName.toLowerCase()
    const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : ""
    result.push({ id, selector: className ? `${tag}.${className}` : tag, width: rect.width, height: rect.height })
  }
  return result
}
