import { expect, test } from 'claude-code/testing'

import { GOLD, PALETTES, mixColor } from '../hooks/cells'
import { buildHeader } from '../hooks/header'
import type { HeaderInput, HeaderModel } from '../hooks/header'
import { fxCells, mix } from '../hooks/headerClient'
import { composeRows, composeText, createMotion, lineCells } from '../hooks/motion'
import type { FoldFx, FolderHeadProps } from '../types'

const dark = PALETTES.dark

const model = (over: Partial<HeaderInput> = {}): HeaderModel =>
  buildHeader({
    turn: { n: 1, title: 'fix the login', reply: 'Fixed it.', tools: 1, files: ['auth.ts'], durationMs: 41_000, status: 'done' },
    style: 'boxed',
    lines: 2,
    marker: 'triangles',
    edge: 'half',
    palette: dark,
    columns: 100,
    folded: true,
    ...over,
  })

/** The header props the plugin would hand the module for a model at rest: the cells with flag 4 on the text region. */
function headProps(m: HeaderModel, fx?: FoldFx): FolderHeadProps {
  const rows = composeRows(createMotion(), 't', m, 'triangles', dark, 'off')
  const texts = composeText(createMotion(), 't', m, dark, 'off')

  return {
    kind: 'head',
    turnId: 't',
    rows: m.rows.map((row, r) =>
      lineCells(rows, texts, m, r).map((c): [number, string, number, number, number] => {
        const region = row.text
        const isText = region !== null && c.col >= region.col && c.col < region.col + region.width

        return [c.col, c.text, c.fg ?? -1, c.bg ?? -1, (c.bold ? 1 : 0) | (c.dim ? 2 : 0) | (isText ? 4 : 0)]
      }),
    ),
    press: [],
    outline: [],
    cyclic: false,
    level: 'lively',
    glint: dark.glint,
    tint: [dark.hoverTitle, dark.hoverReply],
    ...(fx === undefined ? {} : { fx }),
  }
}

/** A fold effect for a model whose marker rests on `rest` (folded: `▸` teal) and flips from `other`. */
function fxOf(m: HeaderModel, kind: 'fold' | 'unfold', age = 0): FoldFx {
  const folded = kind === 'fold'

  return {
    kind,
    age,
    marker: [m.marker.row, m.marker.col, folded ? 0x25b8 : 0x25be, folded ? dark.marker : dark.markerOpen, folded ? 0x25be : 0x25b8, folded ? dark.markerOpen : dark.marker],
    flash: 1,
    gold: GOLD,
  }
}

const textsOf = (rows: FolderHeadProps['rows']): string[] => rows.map(r => r.map(c => c[1]).join(''))

const at = (rows: FolderHeadProps['rows'], r: number, col: number) => rows[r]!.find(c => c[0] === col)!

// ---- the pure helpers ----------------------------------------------------------------------------

test('mix blends per channel like mixColor', () => {
  for (const [a, b, t] of [[0x00afaf, 0xfff5d7, 0.6], [0x8a8a8a, GOLD, 0.25], [0x585858, 0x5fd7d7, 0], [0x585858, 0x5fd7d7, 1]] as const) {
    expect(mix(a, b, t)).toBe(mixColor(a, b, t))
  }
})

// ---- the fold effect -----------------------------------------------------------------------------

test('fxCells, a fold: every frame is a complete card and only the marker cell changes', () => {
  const m = model()
  const props = headProps(m, fxOf(m, 'fold'))
  const rest = textsOf(props.rows)
  expect(rest[0]!.length).toBe(98)
  const { row, col } = m.marker
  for (let f = 0; f < 8; f++) {
    const cells = fxCells(props, f)
    const expected = rest.map((s, r) => (r === row ? Array.from(s).map((ch, c) => (c === col ? (f < 2 ? '▾' : '▸') : ch)).join('') : s))
    expect(textsOf(cells)).toEqual(expected)
    // The right side and the borders are there in the first frame.
    expect(at(cells, 1, 97)[1]).toBe('│')
    expect(at(cells, 0, 97)[1]).toBe('╮')
    expect(at(cells, 3, 0)[1]).toBe('╰')
    // No other cell differs from rest: no sweep, no glide.
    cells.forEach((rowCells, r) =>
      rowCells.forEach((c, i) => {
        if (r !== row || c[0] !== col) expect(c).toEqual(props.rows[r]![i]!)
      }),
    )
  }
  // The marker: the other glyph for two frames, the rest glyph after, gold fading out over the flip.
  const marker = (f: number) => at(fxCells(props, f), row, col)
  expect(marker(0)[1]).toBe('▾')
  expect(marker(1)[1]).toBe('▾')
  expect(marker(2)[1]).toBe('▸')
  for (const f of [0, 1, 2, 3]) expect(marker(f)[2]).toBe(GOLD)
  expect(marker(6)[2]).toBe(mix(dark.marker, GOLD, 0.5))
  expect(marker(8)).toEqual(at(props.rows, row, col))
  // From frame 8 the rows are the rest rows.
  expect(fxCells(props, 8)).toEqual(props.rows)
  expect(fxCells(props, 200)).toEqual(props.rows)
})

test('fxCells, an unfold: the marker flips and nothing else in the header changes', () => {
  const m = model({ folded: false, style: 'rail' })
  const props = headProps(m, fxOf(m, 'unfold'))
  const { row, col } = m.marker
  expect(at(fxCells(props, 0), row, col)[1]).toBe('▸')
  expect(at(fxCells(props, 1), row, col)[1]).toBe('▸')
  expect(at(fxCells(props, 2), row, col)[1]).toBe('▾')
  expect(at(fxCells(props, 6), row, col)[2]).toBe(mix(dark.markerOpen, GOLD, 0.5))
  for (let f = 0; f < 8; f++) {
    fxCells(props, f).forEach((rowCells, r) =>
      rowCells.forEach((c, i) => {
        if (r !== row || c[0] !== col) expect(c).toEqual(props.rows[r]![i]!)
      }),
    )
  }
  expect(fxCells(props, 8)).toEqual(props.rows)
})

test('fxCells with no effect hands the rows back', () => {
  const m = model()
  const props = headProps(m)
  expect(fxCells(props, 0)).toBe(props.rows)
})
