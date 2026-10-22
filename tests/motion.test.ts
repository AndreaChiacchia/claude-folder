import { expect, test } from 'claude-code/testing'

import { DEFAULT, GOLD, PALETTES, mixColor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import { buildHeader } from '../hooks/header'
import type { HeaderInput, HeaderRow } from '../hooks/header'
import {
  FLIP_FRAMES,
  WIPE_FRAMES,
  advance,
  composeRows,
  composeText,
  createMotion,
  glideAmount,
  glideFrames,
  glowAmount,
  isAnimating,
  isHeaderLit,
  isTextLit,
  lineCells,
  observeHeader,
  textRuns,
  wipeHead,
} from '../hooks/motion'
import type { MotionState } from '../hooks/motion'

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

const sp = (k: number): string => ' '.repeat(k)

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

/** The row as text: the cells, with a line row's text region replaced by its parts' text (as in header.test.ts). */
const rowText = (row: HeaderRow): string => {
  const t = row.text
  if (t === null) return cellText(row.cells)

  return cellText(row.cells.slice(0, t.col)) + t.parts.map(p => p.text).join('') + cellText(row.cells.slice(t.col + t.width))
}

const GLINT = 0xfff5d7
const BAND = 0x1c3030
const dark = PALETTES.dark

/** The small turn the models below are made of: title `ab`, nothing to say after it. */
const turn = (over: Partial<HeaderInput['turn']> = {}): HeaderInput['turn'] => ({
  n: 7,
  title: 'ab',
  reply: '',
  tools: 0,
  files: [],
  durationMs: null,
  status: 'done',
  ...over,
})

/** The model at columns 22 (W 20). */
const model = (over: Partial<HeaderInput> = {}) =>
  buildHeader({
    turn: turn(),
    style: 'rail',
    lines: 2,
    marker: 'triangles',
    edge: 'half',
    palette: dark,
    columns: 22,
    folded: true,
    ...over,
  })

/** A header met, then folded (or opened) 0 ms before now: the effects start at the motion's tick 0. */
function changed(toFolded: boolean, level: 'lively' | 'subtle' | 'off' = 'lively'): MotionState {
  const m = createMotion()
  observeHeader(m, 't', toFolded, 0, 1000, level)
  observeHeader(m, 't', toFolded, 1000, 1000, level)

  return m
}

const rowsAt = (m: MotionState, tick: number, mod = model(), level: 'lively' | 'subtle' | 'off' = 'lively') => {
  m.tick = tick

  return composeRows(m, 't', mod, 'triangles', dark, level)
}

const isBlank = (c: Cell | undefined): boolean => c !== undefined && c.cp === 0x20 && c.fg === DEFAULT && c.bg === DEFAULT

test('wipeHead runs along the width by eighths', () => {
  const heads = (W: number): number[] => Array.from({ length: WIPE_FRAMES }, (_, f) => wipeHead(f, W))
  expect(heads(10)).toEqual([0, 1, 2, 4, 5, 6, 7, 9])
  expect(heads(20)).toEqual([1, 4, 6, 9, 11, 14, 16, 19])
  expect(heads(98)).toEqual([11, 23, 35, 48, 60, 72, 84, 97])
})

test('the marker flips its glyph at frame 2, with a gold flash that fades from frame 4', () => {
  const m = changed(true)
  const mod = model()
  const at = (f: number): Cell => rowsAt(m, f, mod)[mod.marker.row]![mod.marker.col]!
  expect([0, 1, 2, 3, 4, 8].map(f => String.fromCodePoint(at(f).cp))).toEqual(['▾', '▾', '▸', '▸', '▸', '▸'])
  for (const f of [0, 1, 2, 3]) expect(at(f).fg).toBe(GOLD)
  expect(at(6).fg).toBe(mixColor(0x00afaf, GOLD, 0.5))
  // The flip is over at frame 8; the glide lights the text only, so the marker is at rest.
  expect(at(8).fg).toBe(0x00afaf)
  expect(at(30).fg).toBe(0x00afaf)
  // The cell keeps its band.
  expect(at(0).bg).toBe(BAND)
  const subtle = changed(true, 'subtle')
  expect(rowsAt(subtle, 0, mod, 'subtle')[mod.marker.row]![mod.marker.col]!.fg).toBe(mixColor(0x8a8a8a, GOLD, 0.5))
})

test('an unfold flips the folded glyph to the open one', () => {
  const m = changed(false)
  const mod = model({ folded: false })
  const glyph = (f: number): string => String.fromCodePoint(rowsAt(m, f, mod)[mod.marker.row]![mod.marker.col]!.cp)
  expect([glyph(0), glyph(1), glyph(2), glyph(3)]).toEqual(['▸', '▸', '▾', '▾'])
})

/** The text region of the first row at a tick (the model's one line), as the render draws it. */
const textAt = (m: MotionState, tick: number, mod = model(), level: 'lively' | 'subtle' | 'off' = 'lively') => {
  m.tick = tick

  return composeText(m, 't', mod, dark, level)[0]!
}

const isHidden = (c: { text: string; fg: number | null; bold: boolean; dim: boolean; bg: number | null }): boolean =>
  c.text === ' ' && c.fg === null && !c.bold && !c.dim && c.bg === BAND

test('the rail wipe glints the edge bar and the glide leaves the glyphs alone: no cell ever changes its background', () => {
  const m = changed(true)
  const mod = model()
  const rest = mod.rows.map(r => r.cells)
  for (let f = 0; f <= 30; f++) {
    const rows = rowsAt(m, f, mod)
    rows.forEach((cells, i) => cells.forEach((c, col) => expect(c.bg).toBe(mod.rows[i]!.cells[col]!.bg)))
  }
  expect(rowsAt(m, 0, mod)[0]![0]!.fg).toBe(mixColor(0x00afaf, GLINT, 0.6))
  expect(rowsAt(m, 5, mod)[0]![0]!.fg).toBe(mixColor(0x00afaf, GLINT, 0.6 * ((WIPE_FRAMES - 5) / 4)))
  // The glide is text-only: from the end of the wipe and the flip the glyph rows are the rest rows.
  expect(rowsAt(m, 8, mod)[0]![0]!.fg).toBe(0x00afaf)
  for (let f = 8; f <= 30; f++) expect(rowsAt(m, f, mod)).toEqual(rest)
})

test('composeText: a fold reveals the text from the left behind a glint on the head cell', () => {
  const m = changed(true)
  const glintOf = (fg: number): number => mixColor(fg, GLINT, 0.6)
  const f0 = textAt(m, 0)
  expect(f0.length).toBe(7)
  expect(f0.every(isHidden)).toBe(true)
  // The text reads `#7 · ab` from column 4: the number first, then the separator and the title.
  const f1 = textAt(m, 1)
  expect(f1[0]).toEqual({ text: '#', col: 4, fg: glintOf(0x8a8a8a), bg: BAND, bold: true, dim: false })
  expect(f1.slice(1).every(isHidden)).toBe(true)
  const f2 = textAt(m, 2)
  expect(f2[0]).toMatchObject({ text: '#', fg: 0x8a8a8a, bold: true })
  expect(f2[1]).toMatchObject({ text: '7', fg: 0x8a8a8a, bold: true })
  expect(f2[2]).toMatchObject({ text: ' ', col: 6, fg: glintOf(0x8a8a8a) })
  expect(f2.slice(3).every(isHidden)).toBe(true)
  const f3 = textAt(m, 3)
  expect(f3.slice(0, 5).map(c => c.text).join('')).toBe('#7 · ')
  expect(f3[3]).toMatchObject({ text: '·', fg: 0x8a8a8a })
  expect(f3[5]).toMatchObject({ text: 'a', col: 9, fg: glintOf(0x5fd7d7) })
  expect(isHidden(f3[6]!)).toBe(true)
  expect(textAt(m, 4)).toEqual(textAt(createMotion(), 0, model(), 'off'))
})

test('composeText: the glide colors the cells under the light and leaves the rest as they were', () => {
  const m = changed(true)
  const cells = textAt(m, 13)
  const at = glideAmount(5, 20, 5, 'right', 0.6)
  expect(at).toBeGreaterThan(0)
  expect(cells[1]).toEqual({ text: '7', col: 5, fg: mixColor(0x8a8a8a, GLINT, at), bg: BAND, bold: true, dim: false })
  expect(cells[6]).toMatchObject({ text: 'b', col: 10, fg: 0x5fd7d7 })
  expect(cells.every(c => c.bg === BAND)).toBe(true)
  expect(textAt(m, 22)).toEqual(textAt(createMotion(), 0, model(), 'off'))
})

test('isTextLit is true while a wipe or a glide runs', () => {
  const m = changed(true)
  const mod = model()
  const lit = (tick: number, level: 'lively' | 'subtle' | 'off' = 'lively'): boolean => {
    m.tick = tick

    return isTextLit(m, 't', mod, level)
  }
  for (let f = 0; f < 22; f++) expect(lit(f)).toBe(true)
  expect(lit(22)).toBe(false)
  expect(lit(30)).toBe(false)
  expect(lit(0, 'off')).toBe(false)
})

test('textRuns merges neighbours of one style and drops nothing', () => {
  const cells = textAt(createMotion(), 0, model(), 'off')
  expect(textRuns(cells)).toEqual([
    { text: '#7', fg: 0x8a8a8a, bg: BAND, bold: true, dim: false },
    { text: ' · ', fg: 0x8a8a8a, bg: BAND, bold: false, dim: false },
    { text: 'ab', fg: 0x5fd7d7, bg: BAND, bold: true, dim: false },
  ])
  expect(textRuns([])).toEqual([])
})

test('lineCells is the whole line: lead cells, text and tail, W cells wide', () => {
  const mod = model()
  const rest = mod.rows.map(r => r.cells)
  const text = composeText(createMotion(), 't', mod, dark, 'off')
  const cells = lineCells(rest, text, mod, 0)
  expect(cells.map(c => c.text).join('')).toBe('▌ ▸ #7 · ab' + sp(9))
  expect(cells.reduce((sum, c) => sum + c.text.length, 0)).toBe(20)
  expect(cells[0]).toEqual({ text: '▌', col: 0, fg: 0x00afaf, bg: BAND, bold: false, dim: false })
  expect(cells.slice(-9).every(c => c.text === ' ' && c.fg === null && c.bg === BAND)).toBe(true)
  expect(cells[11]).toMatchObject({ col: 11 })
})

test('isHeaderLit is true while the marker flips or the text is lit', () => {
  const folding = changed(true)
  const mod = model()
  const lit = (m: MotionState, tick: number, mo = mod, level: 'lively' | 'subtle' | 'off' = 'lively'): boolean => {
    m.tick = tick

    return isHeaderLit(m, 't', mo, level)
  }
  expect(lit(folding, 0)).toBe(true)
  expect(lit(folding, 21)).toBe(true)
  expect(lit(folding, 22)).toBe(false)
  const opening = changed(false)
  const open = model({ folded: false })
  for (let f = 0; f < 14; f++) expect(lit(opening, f, open)).toBe(true)
  expect(lit(opening, 14, open)).toBe(false)
  expect(lit(folding, 0, mod, 'off')).toBe(false)
})

test('boxed: the bottom border draws in from the left, and the right ends wait for the head', () => {
  const m = changed(true)
  const mod = model({ style: 'boxed' })
  // Row 0 holds the marker and the number (a line row); the border row that draws in is the bottom one.
  expect(mod.rows.map(rowText)).toEqual([
    '╭─ ▸ #7 ' + '─'.repeat(11) + '╮',
    '│ ab' + sp(15) + '│',
    '╰' + '─'.repeat(18) + '╯',
  ])
  const first = rowsAt(m, 0, mod)
  expect(first[2]![0]).toEqual({ cp: 0x2570, fg: 0x00afaf, bg: DEFAULT })
  expect(first[2]![1]).toEqual({ cp: 0x2500, fg: mixColor(0x00afaf, GLINT, 0.6), bg: DEFAULT })
  expect(first[2]!.slice(2).every(isBlank)).toBe(true)
  expect(first[0]![19]!.cp).toBe(0x20)
  expect(first[1]![19]!.cp).toBe(0x20)
  const last = rowsAt(m, 7, mod)
  expect(last[2]![19]).toEqual({ cp: 0x256f, fg: mixColor(0x00afaf, GLINT, 0.6), bg: DEFAULT })
  expect(cellText(last[2]!.slice(0, 19))).toBe('╰' + '─'.repeat(18))
  expect(last[0]![19]!.cp).toBe(0x256e)
  expect(last[1]![19]!.cp).toBe(0x2502)
})

test('rules: the rule holding the marker and the number is a line row, which the wipe leaves as it is', () => {
  const m = changed(true)
  const mod = model({ style: 'rules', turn: turn({ durationMs: 41_000 }) })
  expect(mod.rows[0]!.kind).toBe('line')
  expect(rowText(mod.rows[0]!)).toBe('─── ▸ #7 · 41s ' + '─'.repeat(5))
  // Every cell but the marker's own (which flips) is as at rest.
  const first = rowsAt(m, 0, mod)[0]!
  expect(first.filter((_, col) => col !== mod.marker.col)).toEqual(mod.rows[0]!.cells.filter((_, col) => col !== mod.marker.col))
})

test('off draws the model as it is', () => {
  const m = changed(true)
  const mod = model()
  expect(rowsAt(m, 3, mod, 'off')).toEqual(mod.rows.map(r => r.cells))
})

test('the glide is a cosine bump that is the same read from either end', () => {
  const S = 20
  const G = glideFrames(S)
  expect(G).toBe(14)
  for (let t = 0; t < G; t++) {
    for (let i = 0; i < S; i++) {
      expect(near(glideAmount(i, S, t, 'right', 0.6), glideAmount(S - 1 - i, S, t, 'left', 0.6))).toBe(true)
    }
  }
})

test('the glide is zero outside its band and outside its frames, and never above its peak', () => {
  const S = 20
  const G = glideFrames(S)
  expect(glideAmount(5, S, -1, 'right', 0.6)).toBe(0)
  expect(glideAmount(5, S, G, 'right', 0.6)).toBe(0)
  expect(glideAmount(10, S, 0, 'right', 0.6)).toBe(0)
  let best = 0
  for (let i = 0; i < S; i++) best = Math.max(best, glideAmount(i, S, 7, 'right', 0.6))
  expect(best).toBeLessThanOrEqual(0.6)
  expect(best).toBeGreaterThan(0.4)
})

test('glideFrames: about two cells a frame, between 8 and 30', () => {
  expect(glideFrames(3)).toBe(8)
  expect(glideFrames(10)).toBe(8)
  expect(glideFrames(20)).toBe(14)
  expect(glideFrames(82)).toBe(30)
  expect(glideFrames(500)).toBe(30)
})

test('the glow fades in over three frames and out over the last three', () => {
  expect(near(glowAmount(0, 14, 0.12), 0.04)).toBe(true)
  expect(near(glowAmount(1, 14, 0.12), 0.08)).toBe(true)
  expect(near(glowAmount(2, 14, 0.12), 0.12)).toBe(true)
  expect(near(glowAmount(7, 14, 0.12), 0.12)).toBe(true)
  expect(near(glowAmount(13, 14, 0.12), 0.04)).toBe(true)
  expect(glowAmount(14, 14, 0.12)).toBe(0)
  expect(glowAmount(-1, 14, 0.12)).toBe(0)
})

test('a header first met folded starts no effect, nor does a change older than a second', () => {
  const m = createMotion()
  observeHeader(m, 't1', true, 900, 1000, 'lively')
  expect(m.headers.get('t1')).toEqual({
    seenChangedAt: 900,
    flipStart: null,
    flipToFolded: true,
    wipeStart: null,
    glideStart: null,
    glideDir: 'right',
  })
  observeHeader(m, 't1', false, 2000, 3500, 'lively')
  expect(m.headers.get('t1')?.flipStart).toBeNull()
  expect(m.headers.get('t1')?.seenChangedAt).toBe(2000)
  observeHeader(m, 't1', false, 2000, 3600, 'lively')
  expect(m.headers.get('t1')?.flipStart).toBeNull()
})

test('a fresh fold starts the flip, the wipe and a glide to the right after it; an unfold the flip and a glide to the left', () => {
  const m = createMotion()
  observeHeader(m, 't1', false, 0, 0, 'lively')
  advance(m)
  observeHeader(m, 't1', true, 4000, 4200, 'lively')
  expect(m.headers.get('t1')).toEqual({
    seenChangedAt: 4000,
    flipStart: 1,
    flipToFolded: true,
    wipeStart: 1,
    glideStart: 1 + WIPE_FRAMES,
    glideDir: 'right',
  })
  advance(m)
  observeHeader(m, 't1', false, 6000, 6300, 'lively')
  expect(m.headers.get('t1')).toEqual({
    seenChangedAt: 6000,
    flipStart: 2,
    flipToFolded: false,
    wipeStart: null,
    glideStart: 2,
    glideDir: 'left',
  })
})

test('Off records the change and starts nothing', () => {
  const m = createMotion()
  observeHeader(m, 't1', false, 0, 0, 'off')
  observeHeader(m, 't1', true, 5000, 5100, 'off')
  expect(m.headers.get('t1')?.flipStart).toBeNull()
  expect(m.headers.get('t1')?.seenChangedAt).toBe(5000)
})

test('isAnimating is true through the flip, the wipe and the glide, then false', () => {
  const m = changed(true)
  const W = 20
  const end = WIPE_FRAMES + glideFrames(W)
  expect(end).toBe(22)
  expect(FLIP_FRAMES).toBe(8)
  for (let f = 0; f < end; f++) {
    m.tick = f
    expect(isAnimating(m, 't', W)).toBe(true)
  }
  m.tick = end
  expect(isAnimating(m, 't', W)).toBe(false)
  expect(isAnimating(createMotion(), 'nobody', W)).toBe(false)
})
