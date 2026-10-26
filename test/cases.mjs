import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { PNG } from "pngjs"
import playwright from "playwright"
import { compareShots, forgiveTextRegions } from "../dist/diff.js"
import { urlMatches } from "../dist/fixture.js"
import { normalizeText } from "../dist/geometry.js"
import { mergeClose } from "../dist/png.js"
import { designFromNode, exportOrigin, parseFigmaUrl } from "../dist/pull.js"

const root = path.resolve(import.meta.dirname, "..")
const outRoot = path.join(root, "test", "out")
const work = mkdtempSync(path.join(tmpdir(), "framefit-"))
const avatarPath = path.join(work, "avatar.png")
const fixturePath = path.join(work, "fixture.json")

/** @type {{ url: string, hits: Record<string, number>, close: () => Promise<void> } | undefined} */
let server

describe("framefit", () => {
  before(async () => {
    rmSync(outRoot, { recursive: true, force: true })
    mkdirSync(outRoot, { recursive: true })
    writeFileSync(avatarPath, solidPng(32, 32, [0xe1, 0x1d, 0x48, 255]))
    writeFixture("Мария")
    server = await startServer()
  })

  after(async () => {
    await server?.close()
    rmSync(work, { recursive: true, force: true })
  })

  test("склеивает соседние области и матчит glob фикстуры", () => {
    const merged = mergeClose(
      [
        { x: 0, y: 0, width: 2, height: 2, count: 4, mismatch: 1 },
        { x: 9, y: 0, width: 2, height: 2, count: 4, mismatch: 1 },
      ],
      8,
    )
    assert.equal(merged.length, 1)
    assert.equal(urlMatches("**/api/profile", "http://127.0.0.1:9/api/profile?x=1"), true)
    assert.equal(urlMatches("**/api/profile", "http://127.0.0.1:9/api/orders"), false)
  })

  test("ignore-зона не считается расхождением, различие снаружи считается", async () => {
    const ignored = path.join(outRoot, "ignore")
    mkdirSync(ignored, { recursive: true })
    const reference = path.join(ignored, "reference.png")
    const actual = path.join(ignored, "shot.png")
    writeFileSync(reference, splitPng(20, 20, [255, 0, 0, 255], [255, 255, 255, 255]))
    writeFileSync(actual, splitPng(20, 20, [0, 0, 255, 255], [255, 255, 255, 255]))
    const hidden = await compareShots({
      referencePath: reference,
      actualPath: actual,
      outDir: path.join(ignored, "hidden"),
      ignore: [{ x: 0, y: 0, width: 10, height: 20 }],
      threshold: 0.02,
    })
    assert.equal(hidden.pass, true)
    assert.equal(hidden.mismatchRatio, 0)

    const visible = await compareShots({
      referencePath: reference,
      actualPath: actual,
      outDir: path.join(ignored, "visible"),
      ignore: [],
      threshold: 0.02,
    })
    assert.equal(visible.pass, false)
    assert.ok(visible.mismatchRatio > 0.4)
    assert.ok(visible.regions.length >= 1)
  })

  test("flex проходит check и stress, абсолюты падают на вёрстке, фикс. высота падает на stress", async () => {
    assert.ok(server)
    const reference = await captureReference("/flex", "flex-capture")
    writeFixture("Мария")

    server.hits.profile = 0
    server.hits.avatar = 0
    server.hits.extra = 0
    const flex = await runCli([
      "check",
      "--url",
      `${server.url}/flex`,
      "--reference",
      reference,
      "--fixture",
      fixturePath,
      "--out",
      path.join(outRoot, "flex"),
    ])
    assert.equal(flex.code, 0, flex.stderr + flex.stdout)
    const flexReport = readReport("flex")
    assert.equal(flexReport.visual.pass, true)
    assert.equal(flexReport.layout.pass, true)
    assert.equal(flexReport.layout.absoluteTextChars, 0)
    assert.equal(server.hits.profile, 0)
    assert.equal(server.hits.avatar, 0)
    assert.equal(server.hits.extra, 1)
    assert.ok(flexReport.network.unmatchedRequests.some((item) => item.url.includes("/api/extra")))
    assert.ok(flexReport.network.unusedRoutes.some((item) => item.includes("**/api/unused")))

    const flexStress = await runCli([
      "stress",
      "--url",
      `${server.url}/flex`,
      "--reference",
      reference,
      "--fixture",
      fixturePath,
      "--out",
      path.join(outRoot, "flex-stress"),
    ])
    assert.equal(flexStress.code, 0, flexStress.stderr + flexStress.stdout)

    const absolute = await runCli([
      "check",
      "--url",
      `${server.url}/absolute`,
      "--reference",
      reference,
      "--fixture",
      fixturePath,
      "--out",
      path.join(outRoot, "absolute"),
    ])
    assert.equal(absolute.code, 3, absolute.stderr + absolute.stdout)
    const absoluteReport = readReport("absolute")
    assert.equal(absoluteReport.visual.pass, true)
    assert.equal(absoluteReport.layout.pass, false)
    assert.ok(absoluteReport.layout.absoluteTextRatio > 0)

    writeFixture("Другое")
    const renamed = await runCli([
      "check",
      "--url",
      `${server.url}/flex`,
      "--reference",
      reference,
      "--fixture",
      fixturePath,
      "--threshold",
      "0",
      "--out",
      path.join(outRoot, "renamed"),
    ])
    assert.equal(renamed.code, 2, renamed.stderr + renamed.stdout)
    writeFixture("Мария")

    const clippedReference = await captureReference("/clipped", "clipped-capture")
    const clipped = await runCli([
      "check",
      "--url",
      `${server.url}/clipped`,
      "--reference",
      clippedReference,
      "--fixture",
      fixturePath,
      "--out",
      path.join(outRoot, "clipped"),
    ])
    assert.equal(clipped.code, 0, clipped.stderr + clipped.stdout)

    const clippedStress = await runCli([
      "stress",
      "--url",
      `${server.url}/clipped`,
      "--reference",
      clippedReference,
      "--fixture",
      fixturePath,
      "--out",
      path.join(outRoot, "clipped-stress"),
    ])
    assert.equal(clippedStress.code, 3, clippedStress.stderr + clippedStress.stdout)
    const clippedReport = readReport("clipped-stress")
    assert.equal(clippedReport.layout.pass, false)
    assert.ok(clippedReport.layout.overflow.length + clippedReport.layout.clippedText.length > 0)
    assert.ok(readReport("clipped", "check.json").command === "check", "отчёт check не затирается stress")

    const truncatedStress = await runCli([
      "stress", "--url", `${server.url}/truncated`, "--reference", clippedReference,
      "--fixture", fixturePath, "--out", path.join(outRoot, "truncated-stress"),
    ])
    assert.equal(truncatedStress.code, 0, truncatedStress.stderr + truncatedStress.stdout)
  })

  test("плотная область на строке с верной геометрией не валит визуал, вне строки валит", () => {
    const visual = {
      pass: false, mismatchRatio: 0.005, threshold: 0.02, inkMismatchRatio: 0.05, inkThreshold: 0.1,
      regionGate: { minPixels: 60, density: 0.2 }, failingRegions: 1, diffCount: 100, sizeMismatch: false,
      regions: [{ x: 40, y: 270, width: 100, height: 20, mismatch: 0.2, inkDensity: 0.21, pixels: 100, failing: true, elements: [] }],
    }
    const onText = forgiveTextRegions(visual, [{ x: 40, y: 268, width: 235, height: 34 }])
    assert.equal(onText.pass, true)
    assert.equal(onText.regions[0].textNoise, true)
    const elsewhere = forgiveTextRegions(visual, [{ x: 40, y: 400, width: 235, height: 34 }])
    assert.equal(elsewhere.pass, false)
    assert.equal(elsewhere.failingRegions, 1)
  })

  test("допуск сдвига гасит 1px, но не 2px", async () => {
    const dir = path.join(outRoot, "shift")
    mkdirSync(dir, { recursive: true })
    const reference = path.join(dir, "reference.png")
    writeFileSync(reference, barPng(40, 20, 10))
    const results = {}
    for (const offset of [1, 2]) {
      const actual = path.join(dir, `bar-${offset}.png`)
      writeFileSync(actual, barPng(40, 20, 10 + offset))
      results[offset] = await compareShots({
        referencePath: reference,
        actualPath: actual,
        outDir: path.join(dir, `out-${offset}`),
        ignore: [],
        threshold: 0.5,
      })
    }
    assert.equal(results[1].pass, true)
    assert.equal(results[1].diffCount, 0)
    assert.equal(results[2].pass, false)
    assert.ok(results[2].inkMismatchRatio > 0.1)
  })

  test("сдвиг текста на 2px валит check по геометрии и привязывает область к элементу", async () => {
    assert.ok(server)
    const reference = await captureReference("/flex", "geometry-capture")
    writeFixture("Мария")
    const designPath = path.join(outRoot, "geometry-design.json")
    writeFileSync(designPath, JSON.stringify(await designFromPage(`${server.url}/flex`)))

    const flex = await runCli([
      "check", "--url", `${server.url}/flex`, "--reference", reference, "--fixture", fixturePath,
      "--design", designPath, "--out", path.join(outRoot, "geometry-flex"),
    ])
    assert.equal(flex.code, 0, flex.stderr + flex.stdout)
    const flexReport = readReport("geometry-flex")
    assert.equal(flexReport.geometry.pass, true)
    assert.equal(flexReport.geometry.matches.length, 3)
    assert.ok(flexReport.fonts.some((font) => font.family === "Arial"))

    const shifted = await runCli([
      "check", "--url", `${server.url}/shifted`, "--reference", reference, "--fixture", fixturePath,
      "--design", designPath, "--out", path.join(outRoot, "geometry-shifted"),
    ])
    assert.equal(shifted.code, 2, shifted.stderr + shifted.stdout)
    const shiftedReport = readReport("geometry-shifted")
    assert.ok(shiftedReport.visual.mismatchRatio <= 0.02, "глобальная доля сама по себе такой сдвиг пропускает")
    assert.equal(shiftedReport.geometry.pass, false)
    const price = shiftedReport.geometry.matches.find((match) => match.text === "1200 ₽")
    assert.equal(price.dy, 2)
    assert.equal(price.pass, false)
    assert.ok(shiftedReport.visual.regions.some((region) => region.elements.some((label) => label.includes("1200"))))

    const design = JSON.parse(readFileSync(designPath, "utf8"))
    design.texts[0].fontFamily = "Golos Text"
    const wrongFont = path.join(outRoot, "geometry-font.json")
    writeFileSync(wrongFont, JSON.stringify(design))
    const font = await runCli([
      "check", "--url", `${server.url}/flex`, "--reference", reference, "--fixture", fixturePath,
      "--design", wrongFont, "--out", path.join(outRoot, "geometry-font"),
    ])
    assert.equal(font.code, 2, font.stderr + font.stdout)
    assert.ok(readReport("geometry-font").geometry.matches[0].problems.some((problem) => problem.includes("Golos Text")))
  })

  test("подгонка через relative, transform и отрицательный margin валит вёрстку", async () => {
    assert.ok(server)
    const reference = await captureReference("/flex", "nudged-capture")
    writeFixture("Мария")
    const nudged = await runCli([
      "check", "--url", `${server.url}/nudged`, "--reference", reference, "--fixture", fixturePath,
      "--out", path.join(outRoot, "nudged"),
    ])
    assert.ok(nudged.code === 3 || nudged.code === 4, nudged.stderr + nudged.stdout)
    const kinds = new Set(readReport("nudged").layout.nudged.map((issue) => issue.kind))
    assert.deepEqual([...kinds].sort(), ["negative-margin", "relative-offset", "transform"])
  })

  test("--selector снимает компонент внутри страницы", async () => {
    assert.ok(server)
    writeFixture("Мария")
    const reference = await captureReference("/flex", "selector-capture", ["--selector", ".screen"])
    const embedded = await runCli([
      "check", "--url", `${server.url}/embedded`, "--reference", reference, "--fixture", fixturePath,
      "--selector", ".screen", "--viewport", "600x500", "--out", path.join(outRoot, "embedded"),
    ])
    assert.equal(embedded.code, 0, embedded.stderr + embedded.stdout)
    const report = readReport("embedded")
    assert.equal(report.layout.absoluteTextChars, 0, "фиксированное меню вне компонента не считается")

    const stress = await runCli([
      "stress", "--url", `${server.url}/embedded`, "--fixture", fixturePath,
      "--selector", ".screen", "--viewport", "600x500", "--out", path.join(outRoot, "embedded-stress"),
    ])
    assert.equal(stress.code, 0, stress.stderr + stress.stdout)
    const stressReport = readReport("embedded-stress", "stress.json")
    assert.deepEqual(Object.keys(stressReport.screenshots).sort(), ["narrow", "short", "wide"])
  })

  test("pull: разбор ссылки и инвентарь текстов из дерева Figma", () => {
    assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbC123/Card?node-id=1279-13765&t=x"), {
      fileKey: "AbC123",
      nodeId: "1279:13765",
    })
    assert.equal(parseFigmaUrl("https://www.figma.com/design/AbC/branch/BrK/Card?node-id=1-3").fileKey, "BrK")
    assert.throws(() => parseFigmaUrl("https://www.figma.com/design/AbC/Card"))

    const root = {
      id: "1:3",
      type: "FRAME",
      absoluteBoundingBox: { x: 100, y: 200, width: 350, height: 506 },
      absoluteRenderBounds: { x: 90, y: 190, width: 370, height: 526 },
      children: [
        {
          id: "1:4",
          type: "TEXT",
          characters: "Льняной пиджак",
          style: { fontFamily: "Golos Text", fontWeight: 700, fontSize: 28, lineHeightPx: 32, lineHeightUnit: "PIXELS" },
          fills: [{ type: "SOLID", color: { r: 0.16, g: 0.13, b: 0.11, a: 1 } }],
          absoluteBoundingBox: { x: 120, y: 450, width: 214, height: 32 },
        },
        { id: "1:5", type: "TEXT", visible: false, characters: "скрыт", absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    }
    const origin = exportOrigin(root, { width: 350, height: 506 }, 1)
    const design = designFromNode(root, origin)
    assert.deepEqual(design.frame, { width: 350, height: 506 })
    assert.deepEqual(design.fonts, ["Golos Text"])
    assert.equal(design.texts.length, 1)
    assert.equal(design.texts[0].x, 20)
    assert.equal(design.texts[0].y, 250)
    assert.equal(design.texts[0].color, "#29211c")
    assert.equal(normalizeText("Носится\nповерх  рубашки"), normalizeText("Носится поверх рубашки"))
  })
})

async function designFromPage(url) {
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 280 } })
    await page.route("**/api/profile", (route) => route.fulfill({ json: { name: "Мария" } }))
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector("#name")?.textContent === "Мария")
    const texts = await page.evaluate(() =>
      ["#name", "h2", ".card p"].map((selector) => {
        const element = document.querySelector(selector)
        const range = document.createRange()
        range.selectNodeContents(element)
        const rect = range.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          text: element.textContent,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          fontFamily: style.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, ""),
          fontWeight: Number(style.fontWeight),
          fontSize: parseFloat(style.fontSize),
        }
      }),
    )
    return { frame: { width: 400, height: 280 }, fonts: ["Arial"], texts }
  } finally {
    await browser.close()
  }
}

async function launch() {
  try {
    return await playwright.chromium.launch({ headless: true })
  } catch {
    return await playwright.chromium.launch({ headless: true, channel: "chrome" })
  }
}

async function captureReference(pathname, name, extra = []) {
  const dummy = path.join(outRoot, `${name}-dummy.png`)
  writeFileSync(dummy, solidPng(400, 280, [0, 0, 0, 255]))
  const out = path.join(outRoot, name)
  const first = await runCli([
    "check",
    "--url",
    `${server.url}${pathname}`,
    "--reference",
    dummy,
    "--fixture",
    fixturePath,
    "--out",
    out,
    ...extra,
  ])
  assert.notEqual(first.code, 1, first.stderr + first.stdout)
  const shot = path.join(out, "actual.png")
  const reference = path.join(outRoot, `${name}-reference.png`)
  writeFileSync(reference, readFileSync(shot))
  return reference
}

function writeFixture(name) {
  writeFileSync(
    fixturePath,
    JSON.stringify({
      routes: [
        { method: "GET", url: "**/api/profile", json: { name } },
        { method: "GET", url: "**/api/unused", json: { ok: false } },
      ],
      assets: [{ url: "**/media/avatar.png", file: avatarPath }],
    }),
  )
}

function readReport(name, file = "report.json") {
  return JSON.parse(readFileSync(path.join(outRoot, name, file), "utf8"))
}

function barPng(width, height, barX) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ink = x >= barX && x < barX + 2 && y >= 4 && y < height - 4
      const offset = (width * y + x) << 2
      png.data[offset] = ink ? 20 : 250
      png.data[offset + 1] = ink ? 20 : 250
      png.data[offset + 2] = ink ? 20 : 250
      png.data[offset + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "dist", "cli.js"), ...args], { cwd: root })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function startServer() {
  const hits = { profile: 0, avatar: 0, extra: 0 }
  const server = createServer((request, response) => {
    const url = request.url ?? "/"
    if (url.startsWith("/api/profile")) {
      hits.profile++
      return json(response, { name: "Чужой" })
    }
    if (url.startsWith("/api/extra")) {
      hits.extra++
      return json(response, { ok: true })
    }
    if (url.startsWith("/media/avatar.png")) {
      hits.avatar++
      response.writeHead(200, { "content-type": "image/png" })
      response.end(readFileSync(avatarPath))
      return
    }
    if (["/flex", "/absolute", "/clipped", "/truncated", "/shifted", "/nudged", "/embedded"].includes(url)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(page(url.slice(1)))
      return
    }
    response.writeHead(404)
    response.end()
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hits,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function page(kind) {
  if (kind === "clipped" || kind === "truncated") {
    const attribute = kind === "truncated" ? " data-framefit-truncate" : ""
    return `<!doctype html><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; background: #f4f1ea; }
      #clip {
        margin: 24px;
        width: 80px;
        height: 24px;
        overflow: hidden;
        white-space: nowrap;
        font-family: "Courier New", Courier, monospace;
        font-size: 16px;
        line-height: 24px;
      }
    </style><div id="clip"${attribute}>Мария</div>`
  }
  const variants = {
    flex: `main { max-width: 400px; }`,
    absolute: `main { position: relative; width: 400px; height: 280px; }
       .screen { position: absolute; inset: 0; }`,
    shifted: `main { max-width: 400px; } .card p { margin-top: 10px; }`,
    nudged: `main { max-width: 400px; }
       h2 { position: relative; top: 1px; }
       .card p { transform: translateX(2px); }
       header { margin-left: -2px; margin-right: 2px; }`,
    embedded: `body { padding: 60px 0 0 30px; } nav { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: #333; }
       main { width: 400px; }`,
  }
  const layout = variants[kind]
  const nav = kind === "embedded" ? `<nav>Меню</nav>` : ""
  return `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #f4f1ea; color: #1c1917; }
    body { font-family: Arial, Helvetica, sans-serif; }
    .screen { width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 16px; padding: 24px; }
    header {
      height: 64px; background: #1c1917; color: #fff;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 16px; font-size: 24px; line-height: 32px;
    }
    header img { width: 32px; height: 32px; display: block; }
    .card { height: 120px; background: #fff; padding: 16px; }
    h2 { margin: 0; font-size: 18px; font-weight: 700; line-height: 24px; }
    .card p { margin: 8px 0 0; font-size: 16px; line-height: 24px; }
    ${layout}
  </style>
  ${nav}<main><div class="screen">
    <header><span id="name"></span><img src="/media/avatar.png" alt=""></header>
    <section class="card"><h2>Заказ</h2><p>1200 ₽</p></section>
  </div></main>
  <script>
    Promise.all([
      fetch("/api/profile").then((response) => response.json()),
      fetch("/api/extra").then((response) => response.json()),
    ]).then(([profile]) => {
      document.querySelector("#name").textContent = profile.name
    })
  </script>`
}

function solidPng(width, height, rgba) {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0]
    png.data[i + 1] = rgba[1]
    png.data[i + 2] = rgba[2]
    png.data[i + 3] = rgba[3]
  }
  return PNG.sync.write(png)
}

function splitPng(width, height, left, right) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = x < width / 2 ? left : right
      const offset = (width * y + x) << 2
      png.data[offset] = color[0]
      png.data[offset + 1] = color[1]
      png.data[offset + 2] = color[2]
      png.data[offset + 3] = color[3]
    }
  }
  return PNG.sync.write(png)
}
