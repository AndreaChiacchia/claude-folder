import { expect, test } from 'claude-code/testing'

import { PALETTES, displayWidth, paletteFor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import { buildHeader, cardBottom, outlineOf } from '../hooks/header'
import type { HeaderInput, HeaderRow } from '../hooks/header'

const sp = (k: number): string => ' '.repeat(k)

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

const turn = (over: Partial<HeaderInput['turn']> = {}): HeaderInput['turn'] => ({
  n: 1,
  title: 'fix the login',
  reply: 'Fixed it.',
  tools: 1,
  files: ['auth.ts'],
  durationMs: 41_000,
  status: 'done',
  ...over,
})

const input = (over: Partial<HeaderInput> = {}): HeaderInput => ({
  turn: turn(),
  style: 'rail',
  lines: 2,
  marker: 'triangles',
  edge: 'half',
  palette: PALETTES.dark,
  columns: 100,
  folded: true,
  ...over,
})

/** The row as text: the cells, with the text region replaced by its parts' text. */
const rowText = (row: HeaderRow): string => {
  const t = row.text
  if (t === null) return cellText(row.cells)

  return cellText(row.cells.slice(0, t.col)) + t.parts.map(p => p.text).join('') + cellText(row.cells.slice(t.col + t.width))
}

const texts = (m: ReturnType<typeof buildHeader>): string[] => m.rows.map(rowText)

/** `s` padded with spaces to the 98 cells of a header at 100 columns, with `tail` as its last cells (a band's or a card's end). */
const fit = (s: string, tail = ''): string => s + sp(98 - displayWidth(s) - displayWidth(tail)) + tail

test('rail, folded, two lines: the edge, the marker, the number and the title, then the reply and the stats', () => {
  const m = buildHeader(input())
  expect(texts(m)).toEqual([
    '▌ ▸ #1 · fix the login' + sp(76),
    '▌   └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(51),
  ])
  expect(m.rows.every(r => r.cells.length === 98)).toBe(true)
  expect(m.width).toBe(98)
  expect(m.rows.every(r => r.cells.slice(0, 4).every(c => c.bg === 0x1c3030) && r.cells.slice(-10).every(c => c.bg === 0x1c3030))).toBe(true)
  const first = m.rows[0]!
  expect(first.cells.slice(0, 4).every(c => c.bg === 0x1c3030)).toBe(true)
  expect(first.cells.slice(22).every(c => c.bg === 0x1c3030)).toBe(true)
  expect(first.cells[0]).toEqual({ cp: 0x258c, fg: 0x00afaf, bg: 0x1c3030 })
  expect(m.marker).toEqual({ row: 0, col: 2 })
  expect(first.cells[2]).toEqual({ cp: 0x25b8, fg: 0x00afaf, bg: 0x1c3030 })
  const [number, sep, title] = first.text!.parts
  expect(number).toMatchObject({ text: '#1', kind: 'number', bold: true, fg: 0x8a8a8a, bg: 0x1c3030 })
  expect(sep).toMatchObject({ text: ' · ', kind: 'stats', fg: 0x8a8a8a })
  expect(title).toMatchObject({ text: 'fix the login', kind: 'title', bold: true, fg: 0x5fd7d7, bg: 0x1c3030 })
  expect(m.band).toBe(0x1c3030)
  expect(m.frame).toBeNull()
})

test('rail, open: the open marker and the turn number alone on the lavender band', () => {
  const m = buildHeader(input({ folded: false }))
  expect(texts(m)).toEqual(['▌ ▾ #1' + sp(92)])
  expect(m.rows.length).toBe(1)
  expect(m.rows[0]!.cells[2]).toEqual({ cp: 0x25be, fg: 0x8a8a8a, bg: 0x26243a })
  expect(m.rows[0]!.cells.slice(0, 4).every(c => c.bg === 0x26243a)).toBe(true)
  expect(m.rows[0]!.cells.slice(6).every(c => c.bg === 0x26243a)).toBe(true)
  expect(m.rows[0]!.text!.parts).toEqual([{ text: '#1', kind: 'number', fg: 0x8a8a8a, bg: 0x26243a, bold: true, dim: false }])
  expect(m.band).toBe(0x26243a)
})

test('rail, one line: the stats follow the title, and give way on a narrow width', () => {
  expect(texts(buildHeader(input({ lines: 1 })))).toEqual(['▌ ▸ #1 · fix the login · 1 tool · edited auth.ts · 41s' + sp(44)])
  expect(texts(buildHeader(input({ lines: 1, columns: 40 })))).toEqual(['▌ ▸ #1 · fix the login' + sp(16)])
})

test('a long title is cut to the room (after the number) and fills the line', () => {
  const long = buildHeader(input({ turn: turn({ title: 'x'.repeat(200) }) }))
  const part = long.rows[0]!.text!.parts.find(p => p.kind === 'title')!
  expect(part.text).toBe('x'.repeat(88) + '…')
  expect(long.rows[0]!.text!.width).toBe(94)
  expect(long.rows[0]!.cells.length).toBe(98)
  const cjk = buildHeader(input({ turn: turn({ title: '日本語'.repeat(40) }) }))
  const cjkPart = cjk.rows[0]!.text!.parts.find(p => p.kind === 'title')!
  expect(cjkPart.text).toBe('日本語'.repeat(14) + '日本' + '…')
  expect(displayWidth(cjkPart.text)).toBe(89)
  expect(cjk.rows[0]!.cells.length).toBe(98)
})

test('the width is the columns less two, from 20 to 510', () => {
  expect(buildHeader(input({ columns: 10 })).width).toBe(20)
  expect(buildHeader(input({ columns: 5000 })).width).toBe(510)
  expect(buildHeader(input({ columns: 100 })).width).toBe(98)
})

test('line 2 gives its room to the stats first: the reply is cut, then dropped, then the stats are cut', () => {
  const long = buildHeader(input({ turn: turn({ reply: 'y'.repeat(200) }) }))
  const reply = long.rows[1]!.text!.parts.find(p => p.kind === 'reply')
  expect(reply?.text).toBe('y'.repeat(59) + '…')
  expect(long.rows[1]!.text!.width).toBe(94)

  const narrow = buildHeader(input({ columns: 40 }))
  expect(texts(narrow)[1]).toBe('▌   └ 1 tool · edited auth.ts · 41s' + sp(3))
  expect(narrow.rows[1]!.text!.parts.some(p => p.kind === 'reply')).toBe(false)

  const tiny = buildHeader(input({ columns: 30 }))
  const parts = tiny.rows[1]!.text!.parts
  expect(parts[parts.length - 1]).toMatchObject({ text: '1 tool · edited auth.…', kind: 'stats' })
  expect(texts(tiny)[1]).toBe('▌   └ 1 tool · edited auth.…')
  expect(tiny.rows[1]!.cells.length).toBe(28)
})

test('no reply and no stats: one row only', () => {
  const m = buildHeader(input({ turn: turn({ tools: 0, files: [], durationMs: null, reply: '' }) }))
  expect(m.rows.length).toBe(1)
})

test('an interrupted turn with no reply keeps its failure word as its own red part', () => {
  const m = buildHeader(input({ turn: turn({ reply: '', status: 'interrupted' }) }))
  expect(texts(m)[1]).toBe('▌   └ 1 tool · edited auth.ts · 41s · interrupted' + sp(49))
  const fail = m.rows[1]!.text!.parts.find(p => p.kind === 'fail')
  expect(fail).toMatchObject({ text: 'interrupted', fg: 0xff0000 })
})

test('zebra: rounded ends, two alternating folded tints and a lavender open one', () => {
  const one = buildHeader(input({ style: 'zebra' }))
  expect(texts(one)).toEqual([
    '▐▸ #1 · fix the login' + sp(76) + '▌',
    '▐  └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(51) + '▌',
  ])
  expect(one.rows.every(r => r.cells.length === 98)).toBe(true)
  // The band covers the cells between the ends; the ends are glyphs in the band color on the terminal's own background.
  expect(one.rows.every(r => r.cells.slice(1, 97).every(c => c.bg === 0x1c3030))).toBe(true)
  for (const r of one.rows) {
    expect(r.cells[0]).toEqual({ cp: 0x2590, fg: 0x1c3030, bg: 0x01000000 })
    expect(r.cells[97]).toEqual({ cp: 0x258c, fg: 0x1c3030, bg: 0x01000000 })
  }
  expect(one.marker).toEqual({ row: 0, col: 1 })
  expect(one.rows[0]!.text).toMatchObject({ col: 3, line: 1 })
  const two = buildHeader(input({ style: 'zebra', turn: turn({ n: 2 }) }))
  expect(two.rows[0]!.cells.slice(1, 97).every(c => c.bg === 0x262626)).toBe(true)
  expect(two.rows[0]!.cells[0]!.fg).toBe(0x262626)
  expect(two.rows[0]!.cells[97]!.fg).toBe(0x262626)
  const open = buildHeader(input({ style: 'zebra', folded: false }))
  expect(texts(open)).toEqual(['▐▾ #1' + sp(92) + '▌'])
  expect(open.rows[0]!.cells.slice(1, 97).every(c => c.bg === 0x26243a)).toBe(true)
  expect(open.rows[0]!.cells[0]).toEqual({ cp: 0x2590, fg: 0x26243a, bg: 0x01000000 })
  expect(open.rows[0]!.cells[97]).toEqual({ cp: 0x258c, fg: 0x26243a, bg: 0x01000000 })
})

test('boxed: a round card with the marker and the number in the top border, and the title and the answer inside', () => {
  const m = buildHeader(input({ style: 'boxed' }))
  expect(texts(m)).toEqual([
    '╭─ ▸ #1 ' + '─'.repeat(89) + '╮',
    '│ fix the login' + sp(82) + '│',
    '│ └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(52) + '│',
    '╰' + '─'.repeat(96) + '╯',
  ])
  expect(m.rows.map(r => r.kind)).toEqual(['line', 'line', 'line', 'border'])
  expect(m.rows.every(r => r.cells.length === 98)).toBe(true)
  expect(m.rows[0]!.cells[0]!.fg).toBe(0x00afaf)
  expect(m.rows[0]!.cells[97]!.fg).toBe(0x00afaf)
  expect(m.rows[1]!.cells[0]).toEqual({ cp: 0x2502, fg: 0x00afaf, bg: 0x01000000 })
  expect(m.rows[1]!.cells[97]).toEqual({ cp: 0x2502, fg: 0x00afaf, bg: 0x01000000 })
  // The marker sits on the border, in the folded color; the title line has none.
  expect(m.rows[0]!.cells[3]).toEqual({ cp: 0x25b8, fg: 0x00afaf, bg: 0x01000000 })
  expect(m.rows[0]!.text).toMatchObject({ col: 5, width: 2, line: 1 })
  expect(m.rows[1]!.text).toMatchObject({ col: 2, line: 1 })
  expect(m.frame).toBe(0x00afaf)
  expect(m.band).toBeNull()
  expect(m.marker).toEqual({ row: 0, col: 3 })
  expect(buildHeader(input({ style: 'boxed', lines: 1 })).rows.length).toBe(3)
})

test("boxed, open: one line row, the card's top border holding the open marker and the number alone", () => {
  const open = buildHeader(input({ style: 'boxed', folded: false }))
  expect(open.rows.length).toBe(1)
  expect(open.rows[0]!.kind).toBe('line')
  expect(texts(open)).toEqual(['╭─ ▾ #1 ' + '─'.repeat(89) + '╮'])
  expect(open.rows[0]!.cells.length).toBe(98)
  expect(open.marker).toEqual({ row: 0, col: 3 })
  expect(open.rows[0]!.cells[3]).toEqual({ cp: 0x25be, fg: 0x8a8a8a, bg: 0x01000000 })
  expect(open.rows[0]!.cells[0]!.fg).toBe(0x585858)
  expect(open.rows[0]!.cells[1]!.fg).toBe(0x585858)
  expect(open.rows[0]!.text).toMatchObject({ col: 5, width: 2, line: 1 })
  expect(open.rows[0]!.text!.parts).toEqual([{ text: '#1', kind: 'number', fg: 0x8a8a8a, bg: null, bold: true, dim: false }])
  expect(open.rows[0]!.cells[97]).toEqual({ cp: 0x256e, fg: 0x585858, bg: 0x01000000 })
  expect(open.frame).toBe(0x585858)
  expect(open.band).toBeNull()
  // A longer number widens the text, not the lead.
  const big = buildHeader(input({ style: 'boxed', folded: false, turn: turn({ n: 12 }) }))
  expect(big.marker.col).toBe(3)
  expect(texts(big)[0]).toBe('╭─ ▾ #12 ' + '─'.repeat(88) + '╮')
})

test('rules: a rule with the marker, the number and the time above plain header lines, in the folded frame color', () => {
  const m = buildHeader(input({ style: 'rules' }))
  const t = texts(m)
  expect(t[0]).toBe('─── ▸ #1 · 41s ' + '─'.repeat(83))
  expect(t[1]).toBe('   fix the login' + sp(82))
  expect(t[2]).toBe('   └ Fixed it. · 1 tool · edited auth.ts' + sp(58))
  expect(m.rows[0]!.kind).toBe('line')
  expect(m.rows[0]!.text).toMatchObject({ col: 6, width: 8, line: 1 })
  expect(m.frame).toBe(PALETTES.dark.frame)
  expect(m.rows[0]!.cells.filter(c => c.cp === 0x2500).every(c => c.fg === PALETTES.dark.frame)).toBe(true)
  expect(m.rows[0]!.cells[4]).toEqual({ cp: 0x25b8, fg: 0x00afaf, bg: 0x01000000 })
  expect(m.marker).toEqual({ row: 0, col: 4 })
  const noTime = buildHeader(input({ style: 'rules', turn: turn({ durationMs: null }) }))
  expect(texts(noTime)[0]).toBe('─── ▸ #1 ' + '─'.repeat(89))
})

test('rules, open: one rule row with the marker and the number, in the open frame color', () => {
  const m = buildHeader(input({ style: 'rules', folded: false }))
  expect(texts(m)).toEqual(['─── ▾ #1 ' + '─'.repeat(89)])
  expect(m.rows.length).toBe(1)
  expect(m.rows[0]!.kind).toBe('line')
  expect(m.marker).toEqual({ row: 0, col: 4 })
  expect(m.rows[0]!.cells[4]).toEqual({ cp: 0x25be, fg: 0x8a8a8a, bg: 0x01000000 })
  expect(m.rows[0]!.text).toMatchObject({ col: 6, width: 2, line: 1 })
  expect(m.frame).toBe(PALETTES.dark.frameOpen)
  expect(m.rows[0]!.cells.filter(c => c.cp === 0x2500).every(c => c.fg === PALETTES.dark.frameOpen)).toBe(true)
})

test('rules and boxed share their frame colors: teal folded, grey open, in both themes', () => {
  for (const palette of [PALETTES.dark, PALETTES.light]) {
    for (const folded of [true, false]) {
      const rules = buildHeader(input({ style: 'rules', folded, palette }))
      const boxed = buildHeader(input({ style: 'boxed', folded, palette }))
      expect(rules.frame).toBe(folded ? palette.frame : palette.frameOpen)
      expect(rules.frame).toBe(boxed.frame)
    }
  }
  expect(PALETTES.light.frame).toBe(0x00afaf)
  expect(PALETTES.light.frameOpen).toBe(0xa8a8a8)
  expect('rule' in PALETTES.dark).toBe(false)
  expect('rule' in PALETTES.light).toBe(false)
})

test('an open header is the marker and the number alone, whatever the style and the lines setting', () => {
  for (const style of ['rail', 'boxed', 'zebra', 'rules'] as const) {
    const two = buildHeader(input({ style, folded: false, lines: 2 }))
    const one = buildHeader(input({ style, folded: false, lines: 1 }))
    expect(two.rows.length).toBe(1)
    expect(one).toEqual(two)
    const parts = two.rows[0]!.text!.parts
    expect(parts.length).toBe(1)
    expect(parts.some(p => ['title', 'stats', 'reply', 'fail'].includes(p.kind))).toBe(false)
    expect(parts[0]).toMatchObject({ text: '#1', kind: 'number', bold: true })
    expect(two.rows[0]!.cells.length).toBe(98)
  }
})

test('the palette follows the theme setting: light only when it starts with light', () => {
  expect(paletteFor('light')).toBe(PALETTES.light)
  expect(paletteFor('light-daltonized')).toBe(PALETTES.light)
  expect(paletteFor('dark')).toBe(PALETTES.dark)
  expect(paletteFor('auto')).toBe(PALETTES.dark)
  expect(paletteFor(undefined)).toBe(PALETTES.dark)
  expect(paletteFor(42)).toBe(PALETTES.dark)
})

test("cardBottom is the open card's bottom border in the open frame color", () => {
  const bottom = cardBottom(98, PALETTES.dark)
  expect(cellText(bottom)).toBe('╰' + '─'.repeat(96) + '╯')
  expect(bottom.every(c => c.fg === 0x585858 && c.bg === 0x01000000)).toBe(true)
})

test('the open band is a lavender-slate unlike the folded tints, and zebraOpen is gone', () => {
  expect(PALETTES.dark.bandOpen).toBe(0x26243a)
  expect(PALETTES.light.bandOpen).toBe(0xebe9f7)
  expect('zebraOpen' in PALETTES.dark).toBe(false)
  expect('zebraOpen' in PALETTES.light).toBe(false)
})

// ---- v6: the pressable text and the outline ----------------------------------------------------

const pressOf = (m: ReturnType<typeof buildHeader>): ({ col: number; width: number } | null)[] => m.rows.map(r => r.press)

const STYLES = ['rail', 'zebra', 'boxed', 'rules'] as const

/** The marker's column, by style: the same folded and open. */
const MARKER_COL = { rail: 2, zebra: 1, boxed: 3, rules: 4 } as const

test('press: exactly one range, the marker, a space and the number on row 0, in every style, folded or open', () => {
  for (const style of STYLES) {
    for (const folded of [true, false]) {
      for (const n of [1, 12]) {
        const m = buildHeader(input({ style, folded, turn: turn({ n }) }))
        expect(pressOf(m)).toEqual(m.rows.map((_, r) => (r === 0 ? { col: MARKER_COL[style], width: n === 12 ? 5 : 4 } : null)))
      }
    }
  }
})

test('the press range is in the same cells folded and open', () => {
  for (const style of STYLES) {
    expect(buildHeader(input({ style })).rows[0]!.press).toEqual(buildHeader(input({ style, folded: false })).rows[0]!.press)
    expect(buildHeader(input({ style })).marker).toEqual(buildHeader(input({ style, folded: false })).marker)
  }
})

test('press: a cut title, a turn with no reply, the one-line form and three lines change nothing', () => {
  const long = buildHeader(input({ turn: turn({ title: 'x'.repeat(200) }) }))
  expect(long.rows[0]!.press).toEqual({ col: 2, width: 4 })
  const interrupted = buildHeader(input({ turn: turn({ reply: '', status: 'interrupted' }) }))
  expect(interrupted.rows[1]!.press).toBeNull()
  expect(interrupted.rows[0]!.press).toEqual({ col: 2, width: 4 })
  // Stats cut into one part leave no reply; line 2 is never pressable anyway.
  const tiny = buildHeader(input({ columns: 30 }))
  expect(tiny.rows[1]!.press).toBeNull()
  expect(buildHeader(input({ lines: 1 })).rows.map(r => r.press)).toEqual([{ col: 2, width: 4 }])
  expect(pressOf(buildHeader(input({ style: 'boxed', lines: 3 })))).toEqual([{ col: 3, width: 4 }, null, null, null, null])
})

test('press: the cells inside it read the marker, a space and the number, in every style, and no other row has one', () => {
  for (const style of STYLES) {
    for (const folded of [true, false]) {
      const m = buildHeader(input({ style, folded }))
      const press = m.rows[0]!.press!
      expect(Array.from(rowText(m.rows[0]!)).slice(press.col, press.col + press.width).join('')).toBe(folded ? '▸ #1' : '▾ #1')
      expect(m.rows.slice(1).every(r => r.press === null)).toBe(true)
    }
  }
})

test('the title, the answer and the stats never fall inside the press range', () => {
  for (const style of STYLES) {
    const m = buildHeader(input({ style, lines: 3 }))
    const press = m.rows[0]!.press!
    m.rows.forEach((row, r) => {
      const text = row.text
      if (text === null) return
      let col = text.col
      for (const p of text.parts) {
        const inside = r === 0 && col < press.col + press.width && col + displayWidth(p.text) > press.col
        // Only the number part of row 0 shares cells with the range.
        expect(inside).toBe(r === 0 && p.kind === 'number')
        col += displayWidth(p.text)
      }
    })
  }
})

test('the number is bold: figures grey when folded, the open title color when open', () => {
  for (const style of STYLES) {
    const folded = buildHeader(input({ style })).rows[0]!.text!.parts.find(p => p.kind === 'number')
    expect(folded).toMatchObject({ text: '#1', bold: true, fg: PALETTES.dark.figures })
    const open = buildHeader(input({ style, folded: false })).rows[0]!.text!.parts.find(p => p.kind === 'number')
    expect(open).toMatchObject({ text: '#1', bold: true, fg: PALETTES.dark.titleOpen })
  }
})

test('outlineOf: the card perimeter, the open card top, the rail bar, the rule and the zebra ends', () => {
  const card = outlineOf(buildHeader(input({ style: 'boxed' })))
  expect(card.cyclic).toBe(true)
  expect(card.path.length).toBe(200)
  expect(card.path.slice(0, 3)).toEqual([[0, 0], [0, 1], [0, 2]])
  expect(card.path[97]).toEqual([0, 97])
  expect(card.path.slice(98, 102)).toEqual([[1, 97], [2, 97], [3, 97], [3, 96]])
  expect(card.path.slice(-4)).toEqual([[3, 1], [3, 0], [2, 0], [1, 0]])

  const open = outlineOf(buildHeader(input({ style: 'boxed', folded: false })))
  expect(open.cyclic).toBe(false)
  expect(open.path.length).toBe(96)
  expect(open.path.every(([r, c]) => r === 0 && (c < 5 || c > 6))).toBe(true)

  expect(outlineOf(buildHeader(input()))).toEqual({ path: [[0, 0], [1, 0]], cyclic: false })
  expect(outlineOf(buildHeader(input({ folded: false })))).toEqual({ path: [[0, 0]], cyclic: false })
  // A folded rule's light runs along row 0 outside its text region (the number and the time, columns 6 to 13).
  const rule = outlineOf(buildHeader(input({ style: 'rules' })))
  expect(rule.cyclic).toBe(false)
  expect(rule.path.length).toBe(90)
  expect(rule.path[0]).toEqual([0, 0])
  expect(rule.path[89]).toEqual([0, 97])
  expect(rule.path.every(([r, c]) => r === 0 && (c < 6 || c > 13))).toBe(true)
  expect(outlineOf(buildHeader(input({ style: 'rules', turn: turn({ durationMs: null }) }))).path.length).toBe(96)
  // An open rule's light runs along the rule outside the number.
  const openRule = outlineOf(buildHeader(input({ style: 'rules', folded: false })))
  expect(openRule.cyclic).toBe(false)
  expect(openRule.path.length).toBe(96)
  expect(openRule.path.every(([r, c]) => r === 0 && (c < 6 || c > 7))).toBe(true)
  expect(outlineOf(buildHeader(input({ style: 'zebra' })))).toEqual({ path: [[1, 0], [0, 0], [0, 97], [1, 97]], cyclic: true })
})

// ---- three lines -------------------------------------------------------------------------------

test('three lines, rail and zebra: the number and the title, the answer after its own branch, then the stats', () => {
  expect(texts(buildHeader(input({ lines: 3 })))).toEqual([
    fit('▌ ▸ #1 · fix the login'),
    fit('▌   ├ Fixed it.'),
    fit('▌   └ 1 tool · edited auth.ts · 41s'),
  ])
  expect(texts(buildHeader(input({ style: 'zebra', lines: 3 })))).toEqual([
    fit('▐▸ #1 · fix the login', '▌'),
    fit('▐  ├ Fixed it.', '▌'),
    fit('▐  └ 1 tool · edited auth.ts · 41s', '▌'),
  ])
  const m = buildHeader(input({ lines: 3 }))
  expect(m.rows.map(r => r.text?.line)).toEqual([1, 2, 3])
  expect(m.rows[1]!.text!.parts.map(p => p.kind)).toEqual(['branch', 'reply'])
  expect(m.rows[2]!.text!.parts.map(p => p.kind)).toEqual(['branch', 'stats', 'stats', 'stats', 'stats', 'stats'])
  expect(m.rows.every(r => r.cells.length === 98)).toBe(true)
  expect(m.marker).toEqual({ row: 0, col: 2 })
})

test('three lines, boxed: a card five rows tall with the title, the answer and the stats inside', () => {
  const m = buildHeader(input({ style: 'boxed', lines: 3 }))
  expect(texts(m)).toEqual([
    '╭─ ▸ #1 ' + '─'.repeat(89) + '╮',
    fit('│ fix the login', '│'),
    fit('│ ├ Fixed it.', '│'),
    fit('│ └ 1 tool · edited auth.ts · 41s', '│'),
    '╰' + '─'.repeat(96) + '╯',
  ])
  expect(m.rows.length).toBe(5)
  expect(m.marker).toEqual({ row: 0, col: 3 })
  // The light runs round the taller card: two rows of 98 and the two sides of three rows each.
  const outline = outlineOf(m)
  expect(outline.cyclic).toBe(true)
  expect(outline.path.length).toBe(2 * 98 + 2 * 3)
  expect(outline.path.slice(98, 102)).toEqual([[1, 97], [2, 97], [3, 97], [4, 97]])
})

test('three lines, rules: the time stays on the rule, so the stats line leaves it out', () => {
  const m = buildHeader(input({ style: 'rules', lines: 3 }))
  expect(texts(m)).toEqual([
    '─── ▸ #1 · 41s ' + '─'.repeat(83),
    fit('   fix the login'),
    fit('   ├ Fixed it.'),
    fit('   └ 1 tool · edited auth.ts'),
  ])
})

test('three lines collapse to the two-line layout without an answer or without stats, and for rules with only a time', () => {
  for (const style of STYLES) {
    const noReply = turn({ reply: '' })
    expect(buildHeader(input({ style, lines: 3, turn: noReply }))).toEqual(buildHeader(input({ style, lines: 2, turn: noReply })))
    const noStats = turn({ tools: 0, files: [], durationMs: null })
    expect(buildHeader(input({ style, lines: 3, turn: noStats }))).toEqual(buildHeader(input({ style, lines: 2, turn: noStats })))
  }
  const onlyTime = turn({ tools: 0, files: [] })
  const rules = buildHeader(input({ style: 'rules', lines: 3, turn: onlyTime }))
  expect(rules).toEqual(buildHeader(input({ style: 'rules', lines: 2, turn: onlyTime })))
  expect(texts(rules)[2]).toBe('   └ Fixed it.' + sp(84))
})

test('three lines name every edited file when they fit, else count them, else cut the stats', () => {
  const three = turn({ tools: 3, files: ['a.ts', 'b.ts', 'c.ts'] })
  expect(texts(buildHeader(input({ lines: 3, turn: three })))[2]).toBe(fit('▌   └ 3 tools · edited a.ts, b.ts, c.ts · 41s'))
  const mid = buildHeader(input({ lines: 3, turn: three, columns: 40 }))
  expect(texts(mid)[2]).toBe('▌   └ 3 tools · edited 3 files · 41s' + sp(2))
  const tiny = buildHeader(input({ lines: 3, turn: three, columns: 30 }))
  const parts = tiny.rows[2]!.text!.parts
  expect(parts[parts.length - 1]).toMatchObject({ text: '3 tools · edited 3 fi…', kind: 'stats' })
  // Line 2 is the answer alone, with the whole width.
  expect(texts(tiny)[1]).toBe('▌   ├ Fixed it.' + sp(13))
})

test('three lines keep a failure word as its own red part on the stats line', () => {
  const m = buildHeader(input({ lines: 3, turn: turn({ status: 'interrupted' }) }))
  expect(texts(m)[2]).toBe(fit('▌   └ 1 tool · edited auth.ts · 41s · interrupted'))
  expect(m.rows[2]!.text!.parts.find(p => p.kind === 'fail')).toMatchObject({ text: 'interrupted', fg: 0xff0000 })
})

// ---- effort heat -------------------------------------------------------------------------------

const QUICK = turn({ tools: 2, durationMs: 29_000 })
const MEDIUM = turn()
const HEAVY = turn({ tools: 10 })
const HEAT = (p: typeof PALETTES.dark): [HeaderInput['turn'], number][] => [
  [QUICK, p.heatQuick],
  [MEDIUM, p.heatMedium],
  [HEAVY, p.heatHeavy],
]

test('heat, boxed: the folded card takes the effort color on its border, corners and sides', () => {
  for (const palette of [PALETTES.dark, PALETTES.light]) {
    for (const [t, color] of HEAT(palette)) {
      const m = buildHeader(input({ style: 'boxed', heat: true, turn: t, palette }))
      expect(m.frame).toBe(color)
      const framing = new Set([0x2500, 0x256d, 0x256e, 0x2570, 0x256f, 0x2502])
      const cells = m.rows.flatMap(r => r.cells).filter(c => framing.has(c.cp))
      expect(cells.length).toBeGreaterThan(190)
      expect(cells.every(c => c.fg === color)).toBe(true)
    }
  }
})

test('heat, rules: the folded rule takes the effort color', () => {
  for (const [t, color] of HEAT(PALETTES.dark)) {
    const m = buildHeader(input({ style: 'rules', heat: true, turn: t }))
    expect(m.frame).toBe(color)
    const dashes = m.rows[0]!.cells.filter(c => c.cp === 0x2500)
    expect(dashes.length).toBeGreaterThan(80)
    expect(dashes.every(c => c.fg === color)).toBe(true)
  }
})

test('heat, rail: the edge bar cell of each header line takes the effort color, the band stays', () => {
  for (const [t, color] of HEAT(PALETTES.dark)) {
    const m = buildHeader(input({ heat: true, turn: t }))
    expect(m.rows.length).toBe(2)
    for (const row of m.rows) expect(row.cells[0]).toEqual({ cp: 0x258c, fg: color, bg: 0x1c3030 })
    expect(m.rows[0]!.cells[2]).toEqual({ cp: 0x25b8, fg: 0x00afaf, bg: 0x1c3030 })
  }
  expect(buildHeader(input({ heat: true, turn: HEAVY })).rows[0]!.cells[0]!.fg).toBe(0xff5f00)
})

test('heat, zebra: the caps take the effort color on the terminal background, the band stays', () => {
  for (const [t, color] of HEAT(PALETTES.dark)) {
    const m = buildHeader(input({ style: 'zebra', heat: true, turn: t }))
    for (const row of m.rows) {
      expect(row.cells[0]).toEqual({ cp: 0x2590, fg: color, bg: 0x01000000 })
      expect(row.cells[97]).toEqual({ cp: 0x258c, fg: color, bg: 0x01000000 })
      expect(row.cells.slice(1, 97).every(c => c.bg === 0x1c3030)).toBe(true)
    }
  }
})

test('heat: open headers, and a missing or false heat, give the usual colors', () => {
  for (const style of STYLES) {
    expect(buildHeader(input({ style, folded: false, heat: true, turn: HEAVY }))).toEqual(buildHeader(input({ style, folded: false, turn: HEAVY })))
    expect(buildHeader(input({ style, heat: false, turn: HEAVY }))).toEqual(buildHeader(input({ style, turn: HEAVY })))
  }
  expect(buildHeader(input({ style: 'boxed', turn: HEAVY })).frame).toBe(PALETTES.dark.frame)
  expect(buildHeader(input({ heat: true, turn: HEAVY })).band).toBe(0x1c3030)
})

// ---- failed turns ------------------------------------------------------------------------------

const FAILED = [turn({ status: 'interrupted' }), turn({ status: 'error' }), turn({ failedTools: 2 })]

test('a failed turn keeps a red cross after its number, folded or open, in every style', () => {
  for (const style of STYLES) {
    for (const folded of [true, false]) {
      for (const t of FAILED) {
        const parts = buildHeader(input({ style, folded, turn: t })).rows[0]!.text!.parts
        expect(parts[0]).toMatchObject({ text: '#1', kind: 'number' })
        expect(parts[1]).toEqual({ text: ' ✗', kind: 'fail', fg: 0xff0000, bg: parts[0]!.bg, bold: false, dim: false })
      }
    }
  }
  expect(buildHeader(input({ turn: FAILED[0]!, palette: PALETTES.light })).rows[0]!.text!.parts[1]).toMatchObject({ text: ' ✗', fg: 0xd70000 })
  // A turn that did not fail has none, and neither has a running one.
  expect(buildHeader(input()).rows[0]!.text!.parts.some(p => p.text.includes('✗'))).toBe(false)
  expect(buildHeader(input({ turn: turn({ failedTools: 0 }) })).rows[0]!.text!.parts.some(p => p.text.includes('✗'))).toBe(false)
})

test('a failed turn: the cross sits between the number and the rest, in each style', () => {
  const t = turn({ failedTools: 1 })
  expect(texts(buildHeader(input({ turn: t })))[0]).toBe(fit('▌ ▸ #1 ✗ · fix the login'))
  expect(texts(buildHeader(input({ turn: t, folded: false })))).toEqual([fit('▌ ▾ #1 ✗')])
  expect(texts(buildHeader(input({ style: 'zebra', turn: t })))[0]).toBe(fit('▐▸ #1 ✗ · fix the login', '▌'))
  expect(texts(buildHeader(input({ style: 'boxed', turn: t })))[0]).toBe('╭─ ▸ #1 ✗ ' + '─'.repeat(87) + '╮')
  expect(texts(buildHeader(input({ style: 'boxed', turn: t, folded: false })))[0]).toBe('╭─ ▾ #1 ✗ ' + '─'.repeat(87) + '╮')
  expect(texts(buildHeader(input({ style: 'rules', turn: t })))[0]).toBe('─── ▸ #1 ✗ · 41s ' + '─'.repeat(81))
})

test('a failed turn: the pressable range is the marker and the number alone, as for any turn', () => {
  for (const style of STYLES) {
    for (const folded of [true, false]) {
      const failed = buildHeader(input({ style, folded, turn: turn({ status: 'error' }) }))
      expect(pressOf(failed)).toEqual(pressOf(buildHeader(input({ style, folded }))))
      expect(failed.marker).toEqual(buildHeader(input({ style, folded })).marker)
    }
  }
})

test('a failed turn: the title gives up the two cells of the cross', () => {
  const t = turn({ failedTools: 1, title: 'x'.repeat(200) })
  const plainText = texts(buildHeader(input({ turn: turn({ title: 'x'.repeat(200) }), lines: 1, columns: 40 })))[0]!
  const failedText = texts(buildHeader(input({ turn: t, lines: 1, columns: 40 })))[0]!
  expect(displayWidth(failedText)).toBe(38)
  expect(failedText.startsWith('▌ ▸ #1 ✗ · ')).toBe(true)
  expect(plainText.startsWith('▌ ▸ #1 · ')).toBe(true)
  expect(failedText.split('x').length).toBe(plainText.split('x').length - 2)
})
