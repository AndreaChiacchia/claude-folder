import type { Edge, Marker } from '../types'

/** The terminal's default color, as a Raster cell holds it (bit 24 alone). */
export const DEFAULT = 0x01000000

/** The turn number, the stats, the open marker and the open title (dark value). */
export const FIGURES = 0x8a8a8a
/** The folded marker at rest (claudecharter's FILL; dark value). */
export const TEAL = 0x00afaf
/** The siblings' warm white-gold glint (dark value). */
export const GLINT = 0xfff5d7
/** The marker's flip flash (claudecharter's GOLD). */
export const GOLD = 0xffd700
/** The words of an interrupted or failed turn (dark value). */
export const FAIL = 0xff0000

/** Glyphs by code point. */
export const GLYPH = {
  /** The branch of the second line (claudespotter's tree). */
  branch: 0x2514,
  ellipsis: 0x2026,
}

/** The marker pairs by code point. All narrow (East Asian Neutral or ASCII). */
export const MARKERS: Record<Marker, { folded: number; open: number }> = {
  triangles: { folded: 0x25b8, open: 0x25be },
  hollow: { folded: 0x25b9, open: 0x25bf },
  plus: { folded: 0x2b, open: 0x2212 },
  ascii: { folded: 0x3e, open: 0x76 },
}

/** The edge bar's glyph by setting: left half block, left one-quarter block, box vertical, ASCII bar. */
export const EDGES: Record<Edge, number> = { half: 0x258c, thin: 0x258e, line: 0x2502, ascii: 0x7c }

/** The card's glyphs: round corners (the shape of Claude Code's prompt box), the horizontal and the vertical line. */
export const BOX = { tl: 0x256d, tr: 0x256e, bl: 0x2570, br: 0x256f, h: 0x2500, v: 0x2502 }

/** Every color the headers draw, as `0xRRGGBB`; one set per terminal theme. */
export type Palette = {
  /** The folded title (bold). */
  title: number
  /** The open title (bold). */
  titleOpen: number
  /** The turn number, the stats, the rule's label, the card's number. */
  figures: number
  /** The `└` of line 2. */
  branch: number
  /** The edge bar, on header cells and on the rows of an open turn. */
  rail: number
  /** The folded marker. */
  marker: number
  /** The open marker. */
  markerOpen: number
  /** Rail style: the folded band. */
  band: number
  /** Rail and zebra styles: the open header's band (a lavender-slate, unlike the folded tints). */
  bandOpen: number
  /** Zebra: folded, odd turn number. */
  zebraA: number
  /** Zebra: folded, even turn number. */
  zebraB: number
  /** Boxed and rules: the folded card's border and the folded rule. */
  frame: number
  /** Boxed and rules: the open card's border and the open rule. */
  frameOpen: number
  /** The target of wipe heads, glides and ripples. */
  glint: number
  /** Line 1 and rail hover color. */
  hoverTitle: number
  /** Line 2 hover color. */
  hoverReply: number
  /** `interrupted` and `error`. */
  fail: number
}

export const PALETTES: { dark: Palette; light: Palette } = {
  dark: {
    title: 0x5fd7d7,
    titleOpen: 0x8a8a8a,
    figures: 0x8a8a8a,
    branch: 0x585858,
    rail: 0x00afaf,
    marker: 0x00afaf,
    markerOpen: 0x8a8a8a,
    band: 0x1c3030,
    bandOpen: 0x26243a,
    zebraA: 0x1c3030,
    zebraB: 0x262626,
    frame: 0x00afaf,
    frameOpen: 0x585858,
    glint: 0xfff5d7,
    hoverTitle: 0xfff5d7,
    hoverReply: 0xd0d0d0,
    fail: 0xff0000,
  },
  light: {
    title: 0x008787,
    titleOpen: 0x6c6c6c,
    figures: 0x6c6c6c,
    branch: 0xa8a8a8,
    rail: 0x00afaf,
    marker: 0x00afaf,
    markerOpen: 0x6c6c6c,
    band: 0xdff3f3,
    bandOpen: 0xebe9f7,
    zebraA: 0xdff3f3,
    zebraB: 0xececec,
    frame: 0x00afaf,
    frameOpen: 0xa8a8a8,
    glint: 0x5fd7d7,
    hoverTitle: 0x005f5f,
    hoverReply: 0x3a3a3a,
    fail: 0xd70000,
  },
}

/** The palette for the user's `theme` setting: light when it starts with `light`, else dark (dark, daltonized dark, auto, unset). */
export function paletteFor(theme: unknown): Palette {
  return typeof theme === 'string' && theme.startsWith('light') ? PALETTES.light : PALETTES.dark
}

/** `color` moved `amount` (0..1) toward white, per channel; the terminal default stays as it is. */
export function lighten(color: number, amount: number): number {
  if (color === DEFAULT) return DEFAULT
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const up = (c: number): number => Math.round(c + (255 - c) * amount)

  return (up(r) << 16) | (up(g) << 8) | up(b)
}

/** `a` blended into `b` by `t` (0..1), per channel. A side that is the terminal default cannot blend: it switches at the half. */
export function mixColor(a: number, b: number, t: number): number {
  if (a === DEFAULT || b === DEFAULT) return t < 0.5 ? a : b
  const mix = (shift: number): number => {
    const ca = (a >> shift) & 0xff
    const cb = (b >> shift) & 0xff

    return Math.round(ca + (cb - ca) * t)
  }

  return (mix(16) << 16) | (mix(8) << 8) | mix(0)
}

/** `#rrggbb` for Text; undefined for the terminal default. */
export function hex(color: number): string | undefined {
  if (color === DEFAULT) return undefined

  return '#' + (color & 0xffffff).toString(16).padStart(6, '0')
}

export type Cell = { cp: number; fg: number; bg: number }

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6)

const isZeroWidth = (cp: number): boolean => (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f)

const isUnsafe = (cp: number): boolean =>
  cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp > 0xffff || isZeroWidth(cp) || isWide(cp)

/** A code point a Raster takes; anything it would refuse (control, wide, zero-width, beyond the BMP) becomes `?`. */
export function safeCp(cp: number): number {
  return isUnsafe(cp) ? 0x3f : cp
}

/** How many terminal cells `s` takes: 0 for combining marks, zero-width spaces and variation selectors, 2 for wide letters and anything beyond the BMP, else 1. */
export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (isZeroWidth(cp) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    width += isWide(cp) || cp > 0xffff ? 2 : 1
  }

  return width
}

/** One cell per code point of `text`, each through `safeCp`. */
export function textCells(text: string, fg: number, bg: number = DEFAULT): Cell[] {
  const cells: Cell[] = []
  for (const ch of text) {
    cells.push({ cp: safeCp(ch.codePointAt(0) ?? 0x3f), fg, bg })
  }

  return cells
}

/** The Raster's `cells` prop: little-endian u32 triplets [code point, foreground, background], in base64. */
export function encodeCells(cells: Cell[]): string {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((cell, i) => {
    words[i * 3] = cell.cp
    words[i * 3 + 1] = cell.fg
    words[i * 3 + 2] = cell.bg
  })
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

/** The inverse of `encodeCells`. */
export function decodeCells(b64: string): Cell[] {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const cells: Cell[] = []
  for (let i = 0; i + 2 < words.length; i += 3) {
    cells.push({ cp: words[i] ?? 0, fg: words[i + 1] ?? 0, bg: words[i + 2] ?? 0 })
  }

  return cells
}

export type Run = { text: string; fg: number; bg: number }

/** Trailing default-background spaces dropped, then equal neighbours merged: the cells as colored Text runs. */
export function runs(cells: Cell[]): Run[] {
  let end = cells.length
  while (end > 0) {
    const last = cells[end - 1]
    if (last !== undefined && last.cp === 0x20 && last.bg === DEFAULT) end--
    else break
  }

  return merge(cells.slice(0, end))
}

/** Equal neighbours merged, nothing dropped: the cells as colored Text runs that keep their width. */
export function runsAll(cells: Cell[]): Run[] {
  return merge(cells)
}

function merge(cells: Cell[]): Run[] {
  const out: Run[] = []
  for (const cell of cells) {
    const prev = out[out.length - 1]
    const ch = String.fromCodePoint(cell.cp)
    if (prev !== undefined && prev.fg === cell.fg && prev.bg === cell.bg) prev.text += ch
    else out.push({ text: ch, fg: cell.fg, bg: cell.bg })
  }

  return out
}

/** Flag 8 on a header cell sent to the module: a run of one-column cells, one per UTF-16 unit of its text, from its column on. */
export const RUN_FLAG = 8

/** A header cell as the module takes it: `[col, text, fg, bg, flags]` (FolderHeadProps). */
export type HeadCell = [number, string, number, number, number]

/**
 * A header row's cells for the module, packed: neighbouring one-unit cells of the same colors and flags travel as one run
 * (flag 8), which the module unpacks into one cell per UTF-16 unit from the run's column on. Any other cell travels alone.
 */
export function packCells(cells: readonly HeadCell[]): HeadCell[] {
  const out: HeadCell[] = []
  for (const c of cells) {
    const prev = out[out.length - 1]
    const joins =
      prev !== undefined &&
      c[1].length === 1 &&
      (prev[1].length === 1 || (prev[4] & RUN_FLAG) !== 0) &&
      c[0] === prev[0] + prev[1].length &&
      c[2] === prev[2] &&
      c[3] === prev[3] &&
      (prev[4] & ~RUN_FLAG) === c[4]
    if (joins) {
      prev[1] += c[1]
      prev[4] |= RUN_FLAG
    } else {
      out.push([c[0], c[1], c[2], c[3], c[4]])
    }
  }

  return out
}
