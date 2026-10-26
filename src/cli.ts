#!/usr/bin/env node
import { parseArgs } from "node:util"
import { StartupError, errorMessage } from "./errors.js"
import { runPull } from "./pull.js"
import {
  formatReport,
  parsePositive,
  parseRatio,
  parseThreshold,
  parseViewport,
  readReference,
  runCheck,
  runStress,
} from "./run.js"

const help = `framefit pull --figma URL [--out DIR]
  FIGMA_TOKEN в окружении. Пишет reference.png, reference@2x.png, design.json, fixture.draft.json.

framefit check --url URL --reference PNG --fixture JSON [--out DIR]
  [--threshold 0.02] [--ink-threshold 0.1] [--design design.json] [--tolerance 1]
  [--selector CSS] [--viewport WxH] [--scale 1]

framefit stress --url URL --fixture JSON (--reference PNG | --viewport WxH) [--out DIR]
  [--selector CSS] [--scale 1] [--wide 1.15] [--narrow 0.85]

Коды выхода check: 0 всё сошлось, 2 визуал/геометрия, 3 вёрстка, 4 оба, 1 ошибка запуска.
Коды выхода stress: 0 вёрстка прошла, 3 вёрстка не прошла, 1 ошибка запуска.
Коды выхода pull: 0 файлы записаны, 1 ошибка.`

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      url: { type: "string" },
      figma: { type: "string" },
      reference: { type: "string" },
      fixture: { type: "string" },
      design: { type: "string" },
      out: { type: "string", default: ".framefit" },
      threshold: { type: "string" },
      "ink-threshold": { type: "string" },
      tolerance: { type: "string" },
      viewport: { type: "string" },
      selector: { type: "string" },
      scale: { type: "string" },
      wide: { type: "string" },
      narrow: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help || positionals.length === 0) {
    console.log(help)
    return positionals.length === 0 && !values.help ? 1 : 0
  }
  const command = positionals[0]
  const outDir = values.out ?? ".framefit"

  if (command === "pull") {
    if (!values.figma) throw new StartupError("Нужен --figma со ссылкой на фрейм")
    const token = process.env.FIGMA_TOKEN
    if (!token) {
      throw new StartupError("Нет FIGMA_TOKEN. Создайте personal access token в настройках Figma (доступ на чтение файлов) или снимите эталон через Figma MCP")
    }
    const files = await runPull({ figmaUrl: values.figma, outDir, token })
    console.log(["framefit pull", ...files.map((file) => `  ${file}`)].join("\n"))
    return 0
  }

  if (command !== "check" && command !== "stress") {
    throw new StartupError(`Неизвестная команда ${command}. ${help}`)
  }
  if (!values.url) throw new StartupError("Нужен --url")
  if (!values.fixture) throw new StartupError("Нужен --fixture")
  const scale = parseScale(values.scale)
  const selector = values.selector?.trim() || undefined
  const viewport = values.viewport ? parseViewport(values.viewport) : undefined

  if (command === "check") {
    if (!values.reference) throw new StartupError("Для check нужен --reference")
    const report = await runCheck({
      url: values.url,
      referencePath: values.reference,
      fixturePath: values.fixture,
      outDir,
      threshold: parseThreshold(values.threshold),
      inkThreshold: parseRatio(values["ink-threshold"], 0.1, "--ink-threshold"),
      scale,
      selector,
      viewport,
      designPath: values.design,
      tolerance: parsePositive(values.tolerance, 1, "--tolerance"),
    })
    console.log(formatReport(report))
    return report.exitCode
  }

  const stressViewport = viewport ?? (values.reference ? readReference(values.reference, scale).css : undefined)
  if (!stressViewport) throw new StartupError("Для stress нужен --reference или --viewport")
  const narrow = parsePositive(values.narrow, 0.85, "--narrow")
  if (narrow > 1) throw new StartupError("--narrow должен быть не больше 1")
  const wide = parsePositive(values.wide, 1.15, "--wide")
  if (wide < 1) throw new StartupError("--wide должен быть не меньше 1")
  const report = await runStress({
    url: values.url,
    fixturePath: values.fixture,
    outDir,
    viewport: stressViewport,
    scale,
    selector,
    wide,
    narrow,
  })
  console.log(formatReport(report))
  return report.exitCode
}

function parseScale(value: string | undefined): number {
  if (value === undefined) return 1
  const scale = Number(value)
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) throw new StartupError("--scale должен быть целым от 1 до 4")
  return scale
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof StartupError) console.error(error.message)
    else console.error(errorMessage(error))
    process.exit(1)
  })
