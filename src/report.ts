import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CollapseIssue, LayoutProbeResult, LayoutReport, Report, StressPhase } from "./types.js"

export function layoutFromProbe(probe: LayoutProbeResult, mode: "check" | "stress"): LayoutReport {
  const absoluteTextRatio = probe.totalTextChars === 0 ? 0 : probe.absoluteTextChars / probe.totalTextChars
  const overflowFree = probe.overflow.length === 0 && probe.clippedText.length === 0
  const pass = mode === "check"
    ? overflowFree && probe.absoluteTextChars === 0 && probe.nudged.length === 0
    : overflowFree && probe.overlaps.length === 0
  const report: LayoutReport = {
    pass,
    overflow: probe.overflow,
    clippedText: probe.clippedText,
    overlaps: mode === "stress" ? probe.overlaps : [],
  }
  if (mode === "check") {
    report.nudged = probe.nudged
    report.absoluteTextRatio = absoluteTextRatio
    report.absoluteTextChars = probe.absoluteTextChars
    report.totalTextChars = probe.totalTextChars
  }
  return report
}

export function stressLayout(
  phases: Array<{ phase: StressPhase; probe: LayoutProbeResult }>,
  collapsed: CollapseIssue[],
): LayoutReport {
  const overflow = phases.flatMap(({ phase, probe }) => probe.overflow.map((issue) => ({ ...issue, phase })))
  const clippedText = phases.flatMap(({ phase, probe }) => probe.clippedText.map((issue) => ({ ...issue, phase })))
  const overlaps = phases.flatMap(({ phase, probe }) => probe.overlaps.map((issue) => ({ ...issue, phase })))
  return {
    pass: overflow.length === 0 && clippedText.length === 0 && overlaps.length === 0 && collapsed.length === 0,
    overflow,
    clippedText,
    overlaps,
    collapsed,
  }
}

/** Writes `<command>.json` and mirrors it to `report.json` so the latest run is always there. */
export function writeReport(outDir: string, report: Report): Report {
  mkdirSync(outDir, { recursive: true })
  const reportPath = path.join(outDir, `${report.command}.json`)
  const withPath = { ...report, reportPath }
  const body = `${JSON.stringify(withPath, null, 2)}\n`
  writeFileSync(reportPath, body)
  writeFileSync(path.join(outDir, "report.json"), body)
  return withPath
}

export function formatReport(report: Report): string {
  const lines = [`framefit ${report.command}${report.selector ? ` ${report.selector}` : ""}`]
  if (report.error) lines.push(`ошибка: ${report.error}`)
  if (report.visual) {
    const visual = report.visual
    if (visual.sizeMismatch) {
      lines.push(`визуал: ${visual.message ?? "размер не совпал"}`)
    } else {
      lines.push(
        `визуал: ${visual.pass ? "ок" : "не сошёлся"}, расхождение ${percent(visual.mismatchRatio)} (порог ${percent(visual.threshold)}), ` +
          `по контурам ${percent(visual.inkMismatchRatio)} (порог ${percent(visual.inkThreshold)})`,
      )
      if (visual.message) lines.push(`  ${visual.message}`)
      if (visual.failingRegions) lines.push(`  плотных областей: ${visual.failingRegions}`)
      for (const region of visual.regions.slice(0, 8)) {
        const mark = region.failing ? "!" : region.textNoise ? "~" : " "
        const where = region.elements.length ? ` — ${region.elements.join(", ")}` : ""
        const noise = region.textNoise ? " (растеризация шрифта, геометрия строки в норме)" : ""
        lines.push(
          ` ${mark}область ${region.x},${region.y} ${region.width}x${region.height} расхождение ${percent(region.mismatch)}${where}${noise}`,
        )
      }
    }
    if (visual.diff) lines.push(`diff: ${visual.diff}`)
    if (visual.actual) lines.push(`скриншот: ${visual.actual}`)
  }
  if (report.geometry) {
    const geometry = report.geometry
    const failed = geometry.matches.filter((match) => !match.pass)
    lines.push(
      `геометрия: ${geometry.pass ? "ок" : "не сошлась"}, строк ${geometry.matches.length}, с ошибками ${failed.length}, не найдено ${geometry.missing.length}`,
    )
    for (const match of failed.slice(0, 15)) {
      lines.push(`  «${shorten(match.text)}» ${match.selector}: ${match.problems.join(", ")}`)
    }
    for (const text of geometry.missing.slice(0, 10)) lines.push(`  нет на странице: «${shorten(text)}»`)
    for (const text of geometry.extra.slice(0, 10)) lines.push(`  нет в макете: «${shorten(text)}»`)
  }
  if (report.layout) {
    const layout = report.layout
    lines.push(`вёрстка: ${layout.pass ? "ок" : "не прошла"}`)
    if (layout.absoluteTextChars) {
      lines.push(
        `  текст в absolute/fixed: ${percent(layout.absoluteTextRatio ?? 0)} (${layout.absoluteTextChars}/${layout.totalTextChars})`,
      )
    }
    for (const issue of layout.nudged ?? []) {
      lines.push(`  подгонка ${issue.kind}: ${issue.selector} (${issue.value}), текста ${issue.chars} симв.`)
    }
    for (const issue of layout.overflow) {
      lines.push(`  overflow ${issue.kind}${phase(issue.phase)}: ${issue.selector} (${issue.scroll} > ${issue.client})`)
    }
    for (const issue of layout.clippedText) {
      lines.push(`  обрезан текст${phase(issue.phase)}: ${issue.selector} (${issue.scroll} > ${issue.client})`)
    }
    for (const issue of layout.overlaps) {
      lines.push(`  наложение${phase(issue.phase)}: ${issue.a} и ${issue.b}`)
    }
    for (const issue of layout.collapsed ?? []) {
      lines.push(
        `  схлопнулся при коротком тексте: ${issue.selector} (${Math.round(issue.before.width)}x${Math.round(issue.before.height)} → ${Math.round(issue.after.width)}x${Math.round(issue.after.height)})`,
      )
    }
  }
  if (report.fonts?.length) {
    lines.push(`шрифты: ${report.fonts.map((font) => `${font.family} (${font.status})`).join(", ")}`)
  }
  if (report.stressViewports) {
    const { wide, narrow } = report.stressViewports
    lines.push(`стресс-вьюпорты: ${wide.width}x${wide.height}, ${narrow.width}x${narrow.height}`)
  }
  for (const [name, file] of Object.entries(report.screenshots ?? {})) lines.push(`скриншот ${name}: ${file}`)
  const unmatched = report.network.unmatchedRequests
  const unused = report.network.unusedRoutes
  if (unmatched.length > 0 || unused.length > 0) {
    lines.push("сеть:")
    for (const request of unmatched) lines.push(`  без мока: ${request.method} ${request.url}`)
    for (const route of unused) lines.push(`  маршрут не вызван: ${route}`)
  }
  for (const warning of report.warnings) lines.push(`внимание: ${warning}`)
  lines.push(`код: ${report.exitCode}`)
  if (report.reportPath) lines.push(`отчёт: ${report.reportPath}`)
  return lines.join("\n")
}

export function checkExitCode(visualPass: boolean, layoutPass: boolean, sizeMismatch: boolean): number {
  if (sizeMismatch) return 1
  if (visualPass && layoutPass) return 0
  if (!visualPass && layoutPass) return 2
  if (visualPass && !layoutPass) return 3
  return 4
}

function phase(value: StressPhase | undefined): string {
  return value ? ` [${value}]` : ""
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`
}
