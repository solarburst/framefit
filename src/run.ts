import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { Page } from "playwright"
import { settle, takeScreenshot, withPage } from "./browser.js"
import { compareShots, forgiveTextRegions } from "./diff.js"
import { StartupError } from "./errors.js"
import { loadFixture } from "./fixture.js"
import { compareGeometry, loadDesign } from "./geometry.js"
import { readPng } from "./png.js"
import { measureLeaves, probePage, rewriteLeafText } from "./probe.js"
import { checkExitCode, formatReport, layoutFromProbe, stressLayout, writeReport } from "./report.js"
import type { CollapseIssue, FontUsage, LayoutProbeResult, Report, StressPhase, Viewport } from "./types.js"

export type CheckOptions = {
  url: string
  referencePath: string
  fixturePath: string
  outDir: string
  threshold: number
  inkThreshold: number
  scale: number
  selector?: string
  viewport?: Viewport
  designPath?: string
  tolerance: number
}

export async function runCheck(options: CheckOptions): Promise<Report> {
  const fixture = loadFixture(options.fixturePath)
  const reference = readReference(options.referencePath, options.scale)
  const viewport = options.viewport ?? reference.css
  const designPath = options.designPath ?? autoDesign(options.referencePath)
  const design = designPath ? loadDesign(designPath) : undefined
  mkdirSync(options.outDir, { recursive: true })
  const shotPath = path.join(options.outDir, "actual.png")
  const opened = await withPage({
    url: options.url,
    viewport,
    scale: options.scale,
    selector: options.selector,
    fixture,
    run: async (page, network) => {
      await takeScreenshot(page, shotPath, options.selector)
      const probe = await page.evaluate(probePage, { mode: "check" as const, selector: options.selector })
      return { probe, network: network.snapshot() }
    },
  })
  const compared = await compareShots({
    referencePath: options.referencePath,
    actualPath: shotPath,
    outDir: options.outDir,
    ignore: fixture.ignore,
    threshold: options.threshold,
    inkThreshold: options.inkThreshold,
    scale: options.scale,
    allowSizeMismatch: Boolean(options.selector),
    texts: opened.probe.texts,
  })
  const warnings = [...reference.warnings, ...fontWarnings(opened.probe.fonts, design?.fonts)]
  const geometry = design && !compared.sizeMismatch
    ? compareGeometry({
        design,
        designPath: designPath!,
        reference: readPng(options.referencePath),
        actual: readPng(shotPath),
        scale: options.scale,
        texts: opened.probe.texts,
        tolerance: options.tolerance,
      })
    : undefined
  const visual = geometry
    ? forgiveTextRegions(compared, geometry.matches.filter((match) => match.pass).map((match) => match.rect))
    : compared
  if (design && (design.frame.width !== reference.css.width || design.frame.height !== reference.css.height)) {
    warnings.push(
      `Кадр в design ${design.frame.width}x${design.frame.height}, эталон ${reference.css.width}x${reference.css.height}: координаты текстов могут не совпасть`,
    )
  }
  if (!design) warnings.push("Нет design.json: геометрия текста и шрифты с макетом не сверялись")
  const layout = layoutFromProbe(opened.probe, "check")
  const visualPass = visual.pass && (geometry?.pass ?? true)
  const exitCode = checkExitCode(visualPass, layout.pass, visual.sizeMismatch)
  const report: Report = {
    command: "check",
    url: options.url,
    ...(options.selector ? { selector: options.selector } : {}),
    scale: options.scale,
    exitCode,
    viewport,
    error: visual.sizeMismatch ? visual.message : undefined,
    visual,
    ...(geometry ? { geometry } : {}),
    layout,
    fonts: opened.probe.fonts,
    warnings,
    network: opened.network,
  }
  return writeReport(options.outDir, report)
}

export type StressOptions = {
  url: string
  fixturePath: string
  outDir: string
  viewport: Viewport
  scale: number
  selector?: string
  wide: number
  narrow: number
}

export async function runStress(options: StressOptions): Promise<Report> {
  const fixture = loadFixture(options.fixturePath)
  const resize = (factor: number): Viewport => ({
    width: Math.max(1, Math.round(options.viewport.width * factor)),
    height: options.viewport.height,
  })
  const wide = resize(options.wide)
  const narrow = resize(options.narrow)
  mkdirSync(options.outDir, { recursive: true })
  const screenshots: Record<string, string> = {}
  const opened = await withPage({
    url: options.url,
    viewport: options.viewport,
    scale: options.scale,
    selector: options.selector,
    fixture,
    run: async (page, network) => {
      const selector = options.selector
      const phases: Array<{ phase: StressPhase; probe: LayoutProbeResult }> = []
      const phase = async (name: StressPhase, viewport: Viewport) => {
        await page.setViewportSize(viewport)
        await settle(page)
        const file = path.join(options.outDir, `stress-${name}.png`)
        await shoot(page, file, selector)
        screenshots[name] = file
        phases.push({ phase: name, probe: await page.evaluate(probePage, { mode: "stress" as const, selector }) })
      }

      const before = await page.evaluate(measureLeaves, { selector })
      await page.evaluate(rewriteLeafText, { selector, mode: "elongate" as const })
      await phase("wide", wide)
      if (options.narrow < 1) await phase("narrow", narrow)
      await page.evaluate(rewriteLeafText, { selector, mode: "shorten" as const })
      await phase("short", options.viewport)
      const after = await page.evaluate(measureLeaves, { selector })
      const collapsed: CollapseIssue[] = []
      for (const item of before) {
        if (item.width < 1 || item.height < 1) continue
        const now = after.find((other) => other.id === item.id)
        if (!now || (now.width >= 1 && now.height >= 1)) continue
        collapsed.push({
          selector: item.selector,
          before: { width: item.width, height: item.height },
          after: { width: now.width, height: now.height },
        })
      }
      return { phases, collapsed, network: network.snapshot() }
    },
  })
  const layout = stressLayout(opened.phases, opened.collapsed)
  const report: Report = {
    command: "stress",
    url: options.url,
    ...(options.selector ? { selector: options.selector } : {}),
    scale: options.scale,
    exitCode: layout.pass ? 0 : 3,
    viewport: options.viewport,
    stressViewports: { wide, narrow },
    layout,
    warnings: options.narrow < 1 ? [] : ["Сужение вьюпорта отключено (--narrow 1)"],
    screenshots,
    network: opened.network,
  }
  return writeReport(options.outDir, report)
}

async function shoot(page: Page, file: string, selector?: string): Promise<void> {
  if (selector) {
    await takeScreenshot(page, file, selector)
    return
  }
  await page.screenshot({ path: file, type: "png", fullPage: true, animations: "disabled", caret: "hide" })
}

function fontWarnings(fonts: FontUsage[], designFonts?: string[]): string[] {
  const warnings = fonts
    .filter((font) => font.status === "missing")
    .map((font) => `Шрифт «${font.family}» не загрузился, браузер рисует запасной. Пиксели и ширины текста недостоверны`)
  const available = new Set(
    fonts.filter((font) => font.status === "loaded" || font.status === "local").map((font) => font.family.toLowerCase()),
  )
  for (const family of designFonts ?? []) {
    if (!available.has(family.toLowerCase())) warnings.push(`Шрифт макета «${family}» на странице не используется или не загружен`)
  }
  return warnings
}

function autoDesign(referencePath: string): string | undefined {
  const candidate = path.join(path.dirname(path.resolve(referencePath)), "design.json")
  return existsSync(candidate) ? candidate : undefined
}

export function readReference(referencePath: string, scale = 1): { css: Viewport; warnings: string[] } {
  let width: number
  let height: number
  try {
    const png = readPng(referencePath)
    width = png.width
    height = png.height
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new StartupError(`Не удалось прочитать эталон ${path.resolve(referencePath)}: ${message}`)
  }
  const warnings: string[] = []
  if (width % scale !== 0 || height % scale !== 0) {
    warnings.push(`Эталон ${width}x${height} не делится на --scale ${scale}: размер округлён`)
  }
  return { css: { width: Math.round(width / scale), height: Math.round(height / scale) }, warnings }
}

export function parseRatio(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new StartupError(`${flag} должен быть неотрицательным числом, доля (0.02) или проценты (2)`)
  }
  const ratio = parsed > 1 ? parsed / 100 : parsed
  if (ratio > 1) throw new StartupError(`${flag} не может быть больше 100%`)
  return ratio
}

export function parseThreshold(value: string | undefined): number {
  return parseRatio(value, 0.02, "--threshold")
}

export function parsePositive(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new StartupError(`${flag} должен быть положительным числом`)
  return parsed
}

export function parseViewport(value: string): Viewport {
  const match = /^(\d+)x(\d+)$/.exec(value)
  if (!match) throw new StartupError("--viewport ожидает формат 390x844")
  return { width: Number(match[1]), height: Number(match[2]) }
}

export { formatReport }
