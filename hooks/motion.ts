import type { Marker, Motion } from '../types'
import { BOX, DEFAULT, GOLD, MARKERS, displayWidth, mixColor } from './cells'
import type { Cell, Palette } from './cells'
import type { HeaderModel, TextPart } from './header'

/** One frame of the folds (20 fps, as claudespotter and claudeblender). */
export const FRAME_MS = 50
/** The marker's flip: the glyph swaps at frame 2, the gold flash fades out by frame 8. */
export const FLIP_FRAMES = 8
/** The text, the card border or the rule wipes in over this many frames (0.4 s). */
export const WIPE_FRAMES = 8
/** A fold or unfold older than this (ms) is not animated when its header is drawn. */
export const ENTRANCE_WINDOW_MS = 1000
/** First blits refused this many times: the headers are drawn still. */
export const MAX_REFUSED_MOUNTS = 3
/** A finished turn folds this long after it ends under `foldWhen: finish`. */
export const FOLD_DELAY_MS = 1500

/** The last message's glow lasts this long (ms): the fade in, the glow's rise and fall, a hold and the fade out. */
export const SHINE_MS = 3700
/** The shimmer's tint fades in over this long (ms). */
export const SHINE_FADE_IN_MS = 300
/** The glow rises from the tint to the highlight over this long (ms). */
export const SHINE_RISE_MS = 900
/** The glow falls back from the highlight to the tint over this long (ms). */
export const SHINE_FALL_MS = 1500
/** After the glow the tint holds still this long (ms) before it fades out. */
export const SHINE_HOLD_MS = 500
/** The shimmer's tint fades out over this long (ms). */
export const SHINE_FADE_OUT_MS = 500
/** A last message over this many characters keeps the engine's drawing. */
export const SHINE_MAX_CHARS = 6000
/** A last message over this many lines keeps the engine's drawing. */
export const SHINE_MAX_LINES = 120
/** The highlight's strength (0..1) by motion level. */
export const SHINE_STRENGTH = { lively: 1, subtle: 0.5 }

/** How strong each effect is at a motion level. Lights only ever touch foregrounds: no effect changes a background. */
export type Level = {
  /** The marker flip's gold flash (0..1). */
  flash: number
  /** How far the wipe's head (the edge bar, the head cell of the text, the border, the rule) goes toward the glint. */
  glint: number
  /** The gliding light's peak. */
  peak: number
  /** The glide's lift (the lights on the outline are the header module's). */
  glow: number
}

export const LEVELS: Record<'lively' | 'subtle', Level> = {
  lively: { flash: 1, glint: 0.6, peak: 0.6, glow: 0.12 },
  subtle: { flash: 0.5, glint: 0.3, peak: 0.3, glow: 0.06 },
}

/** What one header is doing, in frames of the motion's tick. */
export type HeaderAnim = {
  /** The `changedAt` of the turn the header last drew. */
  seenChangedAt: number
  flipStart: number | null
  /** Whether the flip ends on the folded marker. */
  flipToFolded: boolean
  wipeStart: number | null
  glideStart: number | null
  glideDir: 'right' | 'left'
}

export type MotionState = { tick: number; headers: Map<string, HeaderAnim> }

export function createMotion(): MotionState {
  return { tick: 0, headers: new Map() }
}

/** One frame on. */
export function advance(m: MotionState): void {
  m.tick += 1
}

/**
 * The header of a turn is drawn: a fold or an unfold seen since the last draw (and not older than the entrance window)
 * starts the flip and, folding, the wipe then the light gliding right; unfolding, the light gliding left. A header met
 * for the first time starts no effect.
 */
export function observeHeader(m: MotionState, turnId: string, folded: boolean, changedAt: number, now: number, level: Motion): void {
  const h = m.headers.get(turnId)
  if (h === undefined) {
    m.headers.set(turnId, { seenChangedAt: changedAt, flipStart: null, flipToFolded: folded, wipeStart: null, glideStart: null, glideDir: 'right' })

    return
  }
  if (changedAt === h.seenChangedAt) return
  h.seenChangedAt = changedAt
  if (level === 'off' || now - changedAt > ENTRANCE_WINDOW_MS) return
  h.flipStart = m.tick
  h.flipToFolded = folded
  if (folded) {
    h.wipeStart = m.tick
    h.glideStart = m.tick + WIPE_FRAMES
    h.glideDir = 'right'
  } else {
    h.wipeStart = null
    h.glideStart = m.tick
    h.glideDir = 'left'
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const halfOf = (S: number): number => Math.min(6, Math.max(1.5, S * 0.2))

/** How many frames the light takes to cross `S` cells: about two cells a frame, 8 to 30 frames. */
export function glideFrames(S: number): number {
  const travel = S - 1 + 2 * halfOf(S)

  return clamp(Math.ceil(travel / 2), 8, 30)
}

/**
 * How far cell `i` of `S` is lit by the light at frame `t` of its glide (claudeticker's sweep): a cosine bump 1.5 to 6
 * cells each side that enters off one edge and leaves past the other, `dir` `right` or `left`.
 */
export function glideAmount(i: number, S: number, t: number, dir: 'right' | 'left', peak: number): number {
  const G = glideFrames(S)
  if (t < 0 || t >= G) return 0
  const half = halfOf(S)
  const travel = S - 1 + 2 * half
  const pos = dir === 'right' ? -half + (travel * t) / G : S - 1 + half - (travel * t) / G
  const d = Math.abs(i - pos) / half

  return d < 1 ? (peak * (1 + Math.cos(Math.PI * d))) / 2 : 0
}

/** The whole header's lift while the light of `G` frames glides: it fades in over 3 frames and out over the last 3. */
export function glowAmount(t: number, G: number, glow: number): number {
  if (t < 0 || t >= G) return 0

  return glow * Math.min(1, (t + 1) / 3, (G - t) / 3)
}

/** The last cell the wipe has reached at frame `f` over `W` cells: eighths of the width. */
export function wipeHead(f: number, W: number): number {
  return Math.floor(((f + 1) * W) / WIPE_FRAMES) - 1
}

/** Which effects run for a header at the motion's tick, and where each is in its frames. */
type Windows = {
  /** The frame of the wipe, or null. */
  wipeF: number | null
  /** The frame of the glide, or null. */
  glideT: number | null
  glideDir: 'right' | 'left'
}

function windowsOf(m: MotionState, turnId: string, model: HeaderModel, level: Motion): Windows {
  const none: Windows = { wipeF: null, glideT: null, glideDir: 'right' }
  if (level === 'off') return none
  const G = glideFrames(model.width)
  const h = m.headers.get(turnId)
  let wipeF: number | null = null
  let glideT: number | null = null
  let glideDir: 'right' | 'left' = 'right'
  if (h !== undefined && h.wipeStart !== null) {
    const f = m.tick - h.wipeStart
    if (f >= 0 && f < WIPE_FRAMES) wipeF = f
  }
  if (h !== undefined && h.glideStart !== null) {
    const t = m.tick - h.glideStart
    if (t >= 0 && t < G) {
      glideT = t
      glideDir = h.glideDir
    }
  }

  return { wipeF, glideT, glideDir }
}

/** The wipe at frame `f`, its head at `head`: the rail's edge bar glints; the border and the rule draw from the left. */
function wipe(rows: Cell[][], model: HeaderModel, palette: Palette, L: Level, f: number, head: number): void {
  const W = model.width
  const blank = (): Cell => ({ cp: 0x20, fg: DEFAULT, bg: DEFAULT })
  model.rows.forEach((row, i) => {
    const cells = rows[i]
    if (cells === undefined) return
    if (model.style === 'rail') {
      const edge = cells[0]
      if (row.kind === 'line' && edge !== undefined) {
        const a = L.glint * (f < 4 ? 1 : (WIPE_FRAMES - f) / 4)
        cells[0] = { ...edge, fg: mixColor(palette.rail, palette.glint, a) }
      }

      return
    }
    if (model.style === 'zebra') return
    if (row.kind === 'border') {
      for (let col = head; col < W; col++) {
        const cell = cells[col]
        if (cell === undefined) continue
        if (col > head) cells[col] = blank()
        else {
          cells[col] = {
            cp: cell.cp === 0x20 ? BOX.h : cell.cp,
            fg: mixColor(model.frame ?? palette.frame, palette.glint, L.glint),
            bg: DEFAULT,
          }
        }
      }
    } else if (model.style === 'boxed' && head < W - 1) {
      cells[W - 1] = blank()
    }
  })
}

/**
 * The glyph cells of a header at the motion's tick: the model's cells with the effects over them. The marker flips (gold
 * flash); a fold wipes the border or the rule in from the left behind a warm glint (and glints the rail's edge bar). The
 * light along the outline is the header module's, not this. No cell's background ever changes, and the text regions are
 * not touched here (see `composeText`).
 */
export function composeRows(
  m: MotionState,
  turnId: string,
  model: HeaderModel,
  marker: Marker,
  palette: Palette,
  level: Motion,
): Cell[][] {
  const rows = model.rows.map(r => r.cells.map(c => ({ ...c })))
  if (level === 'off') return rows
  const L = LEVELS[level]
  const h = m.headers.get(turnId)
  const w = windowsOf(m, turnId, model, level)
  const markerLine = rows[model.marker.row]
  const markerCell = markerLine?.[model.marker.col]

  // The marker's flip.
  if (h !== undefined && h.flipStart !== null && markerLine !== undefined && markerCell !== undefined) {
    const f = m.tick - h.flipStart
    if (f >= 0 && f < FLIP_FRAMES) {
      const glyphs = MARKERS[marker]
      const rest = (isFolded: boolean): { cp: number; fg: number } =>
        isFolded ? { cp: glyphs.folded, fg: palette.marker } : { cp: glyphs.open, fg: palette.markerOpen }
      const shown = rest(f < 2 ? !h.flipToFolded : h.flipToFolded)
      const a = f < 4 ? L.flash : (L.flash * (FLIP_FRAMES - f)) / 4
      markerLine[model.marker.col] = { ...markerCell, cp: shown.cp, fg: mixColor(shown.fg, GOLD, a) }
    }
  }

  // The fold wipe.
  if (w.wipeF !== null) wipe(rows, model, palette, L, w.wipeF, wipeHead(w.wipeF, model.width))

  return rows
}

/** One code point of a line row's text, with its first column and its style. A wide letter covers `col` and `col + 1`. */
export type TextCell = { text: string; col: number; fg: number | null; bg: number | null; bold: boolean; dim: boolean }

/** The code points of a text region's parts, at rest. */
function restCells(text: { col: number; parts: TextPart[] }): TextCell[] {
  const out: TextCell[] = []
  let col = text.col
  for (const part of text.parts) {
    for (const ch of part.text) {
      out.push({ text: ch, col, fg: part.fg, bg: part.bg, bold: part.bold, dim: part.dim })
      col += displayWidth(ch)
    }
  }

  return out
}

/**
 * The text regions of a header at the motion's tick, one entry per model row (null for a border row). A fold wipes the
 * text in from the left behind a glint on the head cell; a glide colors the cells the light is over toward the glint.
 * Only foregrounds change: a cell away from the light keeps its exact rest style.
 */
export function composeText(
  m: MotionState,
  turnId: string,
  model: HeaderModel,
  palette: Palette,
  level: Motion,
): (TextCell[] | null)[] {
  const rest = model.rows.map(row => (row.text === null ? null : restCells(row.text)))
  if (level === 'off') return rest
  const L = LEVELS[level]
  const W = model.width
  const w = windowsOf(m, turnId, model, level)
  const lightAt = w.glideT !== null ? { t: w.glideT, dir: w.glideDir, peak: L.peak } : null

  return rest.map(cells => {
    if (cells === null) return null
    let out = cells
    if (w.wipeF !== null) {
      const head = wipeHead(w.wipeF, W)
      out = out.map(c => {
        const width = displayWidth(c.text)
        if (c.col > head) return { ...c, text: ' '.repeat(width), fg: null, bold: false, dim: false }
        if (c.col + width > head) return { ...c, fg: mixColor(c.fg ?? palette.figures, palette.glint, L.glint), dim: false }

        return c
      })
    }
    if (lightAt !== null) {
      out = out.map(c => {
        if (c.text === ' ') return c
        const a = glideAmount(c.col, W, lightAt.t, lightAt.dir, lightAt.peak)

        return a > 0 ? { ...c, fg: mixColor(c.fg ?? palette.figures, palette.glint, a), dim: false } : c
      })
    }

    return out
  })
}

/** True while a wipe or a glide runs for the header: its text cells differ from rest. */
export function isTextLit(m: MotionState, turnId: string, model: HeaderModel, level: Motion): boolean {
  const w = windowsOf(m, turnId, model, level)

  return w.wipeF !== null || w.glideT !== null
}

/** True while the marker flips or the text is lit: any cell of a header line differs from rest. */
export function isHeaderLit(m: MotionState, turnId: string, model: HeaderModel, level: Motion): boolean {
  if (level === 'off') return false
  const h = m.headers.get(turnId)
  if (h !== undefined && h.flipStart !== null) {
    const f = m.tick - h.flipStart
    if (f >= 0 && f < FLIP_FRAMES) return true
  }

  return isTextLit(m, turnId, model, level)
}

/** Neighbouring text cells of equal style merged into runs; nothing dropped. */
export function textRuns(cells: TextCell[]): { text: string; fg: number | null; bg: number | null; bold: boolean; dim: boolean }[] {
  const out: { text: string; fg: number | null; bg: number | null; bold: boolean; dim: boolean }[] = []
  for (const c of cells) {
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.fg === c.fg && prev.bg === c.bg && prev.bold === c.bold && prev.dim === c.dim) prev.text += c.text
    else out.push({ text: c.text, fg: c.fg, bg: c.bg, bold: c.bold, dim: c.dim })
  }

  return out
}

/**
 * Line `r` of a header whole, as text cells: the lead cells of `rows[r]` before the text region, the text region from
 * `text[r]`, and the tail cells after it. Their widths sum to the model's width. A border row (no text region) is its
 * cells alone.
 */
export function lineCells(rows: Cell[][], text: (TextCell[] | null)[], model: HeaderModel, r: number): TextCell[] {
  const cells = rows[r] ?? []
  const region = model.rows[r]?.text ?? null
  const asCell = (c: Cell, col: number): TextCell => ({
    text: String.fromCodePoint(c.cp),
    col,
    fg: c.fg === DEFAULT ? null : c.fg,
    bg: c.bg === DEFAULT ? null : c.bg,
    bold: false,
    dim: false,
  })
  if (region === null) return cells.map((c, col) => asCell(c, col))
  const end = region.col + region.width
  const mid = text[r] ?? restCells(region)

  return [
    ...cells.slice(0, region.col).map((c, col) => asCell(c, col)),
    ...mid,
    ...cells.slice(end).map((c, i) => asCell(c, end + i)),
  ]
}

/** True while a header's flip, wipe or glide has frames left; `W` is the header model's width. */
export function isAnimating(m: MotionState, turnId: string, W: number): boolean {
  const h = m.headers.get(turnId)
  if (h === undefined) return false
  if (h.flipStart !== null && m.tick - h.flipStart < FLIP_FRAMES) return true
  if (h.wipeStart !== null && m.tick - h.wipeStart < WIPE_FRAMES) return true

  return h.glideStart !== null && m.tick < h.glideStart + glideFrames(W)
}
