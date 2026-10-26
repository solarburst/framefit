export type IgnoreRect = {
  x: number
  y: number
  width: number
  height: number
}

export type RouteFixture = {
  method?: string
  url: string
  status?: number
  json?: unknown
  body?: string
  contentType?: string
}

export type AssetFixture = {
  url: string
  file: string
}

export type Fixture = {
  ignore?: IgnoreRect[]
  routes?: RouteFixture[]
  assets?: AssetFixture[]
}

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type Region = Rect & {
  mismatch: number
}

export type ReportedRegion = Region & {
  /** Differing pixels per reference edge (ink) pixel inside the region, capped at 1. */
  inkDensity: number
  pixels: number
  failing: boolean
  /** Dense region lying on strings whose geometry matched: font rasterisation, not layout. */
  textNoise?: boolean
  elements: string[]
}

export type StressPhase = "wide" | "narrow" | "short"

export type BoxIssue = {
  kind: "page-horizontal" | "horizontal" | "clipped-text"
  selector: string
  scroll: number
  client: number
  phase?: StressPhase
}

export type OverlapIssue = {
  a: string
  b: string
  phase?: StressPhase
}

export type NudgeIssue = {
  kind: "relative-offset" | "transform" | "negative-margin"
  selector: string
  value: string
  chars: number
}

export type CollapseIssue = {
  selector: string
  before: { width: number; height: number }
  after: { width: number; height: number }
}

export type FontUsage = {
  family: string
  status: "loaded" | "local" | "generic" | "missing"
  chars: number
}

export type TextBox = {
  selector: string
  text: string
  leaf: boolean
  rect: Rect
  fontFamily: string
  fontWeight: number
  fontSize: number
  lineHeight: number | null
  color: string
}

export type LayoutProbeResult = {
  overflow: BoxIssue[]
  clippedText: BoxIssue[]
  overlaps: OverlapIssue[]
  nudged: NudgeIssue[]
  absoluteTextChars: number
  totalTextChars: number
  fonts: FontUsage[]
  texts: TextBox[]
  origin: { x: number; y: number }
}

export type NetworkRequest = {
  method: string
  url: string
  resourceType: string
}

export type NetworkReport = {
  unmatchedRequests: NetworkRequest[]
  unusedRoutes: string[]
}

export type Viewport = {
  width: number
  height: number
}

export type VisualReport = {
  pass: boolean
  mismatchRatio: number
  threshold: number
  inkMismatchRatio: number
  inkThreshold: number
  regionGate: { minPixels: number; density: number }
  failingRegions: number
  diffCount: number
  sizeMismatch: boolean
  message?: string
  regions: ReportedRegion[]
  actual?: string
  diff?: string
}

export type DesignText = {
  id?: string
  name?: string
  text: string
  x: number
  y: number
  width: number
  height: number
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  lineHeight?: number
  color?: string
}

export type Design = {
  source?: string
  fileKey?: string
  nodeId?: string
  frame: { width: number; height: number }
  fonts?: string[]
  texts: DesignText[]
}

export type GeometryMatch = {
  text: string
  selector: string
  rect: Rect
  pass: boolean
  dx: number | null
  dy: number | null
  dw: number | null
  dh: number | null
  problems: string[]
}

export type GeometryReport = {
  pass: boolean
  design: string
  tolerance: number
  matches: GeometryMatch[]
  missing: string[]
  extra: string[]
}

export type LayoutReport = {
  pass: boolean
  overflow: BoxIssue[]
  clippedText: BoxIssue[]
  overlaps: OverlapIssue[]
  nudged?: NudgeIssue[]
  collapsed?: CollapseIssue[]
  absoluteTextRatio?: number
  absoluteTextChars?: number
  totalTextChars?: number
}

export type Report = {
  command: "check" | "stress"
  url: string
  selector?: string
  scale: number
  exitCode: number
  viewport: Viewport
  stressViewports?: { wide: Viewport; narrow: Viewport }
  error?: string
  visual?: VisualReport
  geometry?: GeometryReport
  layout?: LayoutReport
  fonts?: FontUsage[]
  warnings: string[]
  screenshots?: Record<string, string>
  network: NetworkReport
  reportPath?: string
}
