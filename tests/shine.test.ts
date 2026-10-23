import { expect, test } from 'claude-code/testing'

import { PALETTES } from '../hooks/cells'
import {
  FRAME_MS,
  SHINE_FADE_IN_MS,
  SHINE_FADE_OUT_MS,
  SHINE_HOLD_MS,
  SHINE_MAX_CHARS,
  SHINE_MAX_LINES,
  SHINE_FALL_MS,
  SHINE_MS,
  SHINE_RISE_MS,
  SHINE_STRENGTH,
} from '../hooks/motion'
import { DEFAULT_SETTINGS, normalizeSettings } from '../hooks/settings'
import { shineFits, shineLines, shineProps } from '../hooks/shine'
import * as client from '../hooks/shineClient'
import { ease, mix, shineAmount, shineColor, wrapShine } from '../hooks/shineClient'
import { effortOf, isFailedTurn } from '../hooks/summary'
import type { FolderShineProps, ShineLine } from '../types'

/** One text line of runs with no prefix, as the parser makes it. */
const plain = (...runs: [string, number][]): ShineLine => ({ kind: 'text', prefix: '', indent: 0, runs })

const BLANK: ShineLine = { kind: 'text', prefix: '', indent: 0, runs: [] }

// ---- shineLines --------------------------------------------------------------------------------

test('shineLines: bold, italic, inline code and link labels become runs with flags', () => {
  expect(shineLines('**bold** and *it* and `code` and [link](http://x.y)')).toEqual([
    plain(['bold', 1], [' and ', 0], ['it', 2], [' and code and link', 0]),
  ])
  expect(shineLines('__b__ and _i_ and ![img](a.png)')).toEqual([plain(['b', 1], [' and ', 0], ['i', 2], [' and img', 0]) ])
  // Code keeps the flags of the span it sits in.
  expect(shineLines('**a `b` c**')).toEqual([plain(['a b c', 1])])
  expect(shineLines('***both***')).toEqual([plain(['both', 3])])
})

test('shineLines: a mark with no closer, an escaped mark and a snake_case word stay literal', () => {
  expect(shineLines('**oops')).toEqual([plain(['**oops', 0])])
  expect(shineLines('a * b')).toEqual([plain(['a * b', 0])])
  expect(shineLines('\\*lit\\*')).toEqual([plain(['*lit*', 0])])
  expect(shineLines('snake_case_name')).toEqual([plain(['snake_case_name', 0])])
})

test('shineLines: a heading is bold', () => {
  expect(shineLines('## Title')).toEqual([plain(['Title', 1])])
  expect(shineLines('# A *b*')).toEqual([plain(['A ', 1], ['b', 3])])
})

test('shineLines: list items and quotes carry a prefix and the indent of their continuation lines', () => {
  expect(shineLines('- item')).toEqual([{ kind: 'text', prefix: '- ', indent: 2, runs: [['item', 0]] }])
  expect(shineLines('* star')[0]).toMatchObject({ prefix: '- ', indent: 2 })
  expect(shineLines('  + nested **x**')).toEqual([{ kind: 'text', prefix: '  - ', indent: 4, runs: [['nested ', 0], ['x', 1]] }])
  expect(shineLines('1. one')).toEqual([{ kind: 'text', prefix: '1. ', indent: 3, runs: [['one', 0]] }])
  expect(shineLines('10) ten')).toEqual([{ kind: 'text', prefix: '10. ', indent: 4, runs: [['ten', 0]] }])
  expect(shineLines('> quoted *q*')).toEqual([{ kind: 'text', prefix: '│ ', indent: 2, runs: [['quoted ', 0], ['q', 2]] }])
})

test('shineLines: fences are dropped and code lines are plain, indented by 2, with tabs as two spaces', () => {
  expect(shineLines('```ts\nconst a = **1**\n\tx\n\n```')).toEqual([
    { kind: 'text', prefix: '  ', indent: 2, runs: [['const a = **1**', 0]] },
    { kind: 'text', prefix: '  ', indent: 2, runs: [['  x', 0]] },
    { kind: 'text', prefix: '  ', indent: 2, runs: [] },
  ])
  expect(shineLines('~~~\nx\n~~~\nafter')).toEqual([{ kind: 'text', prefix: '  ', indent: 2, runs: [['x', 0]] }, plain(['after', 0])])
})

test('shineLines: a table keeps its raw lines, a rule is a rule line', () => {
  expect(shineLines('| a | **b** |  \n|---|---|')).toEqual([plain(['| a | **b** |', 0]), plain(['|---|---|', 0])])
  expect(shineLines('---')).toEqual([{ kind: 'rule', prefix: '', indent: 0, runs: [] }])
  expect(shineLines('* * *')[0]?.kind).toBe('rule')
  expect(shineLines('___')[0]?.kind).toBe('rule')
})

test('shineLines: blank lines collapse into one, and the first and last are dropped', () => {
  expect(shineLines('\n\na\n\n\n\nb\n\n')).toEqual([plain(['a', 0]), BLANK, plain(['b', 0])])
  expect(shineLines('')).toEqual([])
  expect(shineLines('a\r\nb')).toEqual([plain(['a', 0]), plain(['b', 0])])
})

test('shineFits: at most 6,000 characters and 120 lines', () => {
  expect(SHINE_MAX_CHARS).toBe(6000)
  expect(SHINE_MAX_LINES).toBe(120)
  expect(shineFits('x'.repeat(6000))).toBe(true)
  expect(shineFits('x'.repeat(6001))).toBe(false)
  expect(shineFits(Array.from({ length: 120 }, () => 'x').join('\n'))).toBe(true)
  expect(shineFits(Array.from({ length: 121 }, () => 'x').join('\n'))).toBe(false)
})

test('shineProps: the preset colors of the theme, the text color and the strength of the motion level', () => {
  const lively = shineProps({ turnId: 't1', text: 'Hi', bullet: true, age: 120, cols: 90, palette: PALETTES.dark, shimmer: 'gold', motion: 'lively' })
  expect(lively).toEqual({
    kind: 'shine',
    turnId: 't1',
    age: 120,
    cols: 90,
    bullet: true,
    lines: [plain(['Hi', 0])],
    text: 0xffffff,
    base: 0xd4a017,
    peak: 0xfff1a8,
    strength: 1,
  })
  const subtle = shineProps({ turnId: 't1', text: 'Hi', bullet: false, age: 0, cols: 90, palette: PALETTES.light, shimmer: 'silver', motion: 'subtle' })
  expect(subtle).toMatchObject({ text: 0x000000, base: 0x6c6c6c, peak: 0x262626, strength: 0.5, bullet: false })
})

test('the presets: gold, text, teal, silver and lavender, in both themes', () => {
  expect(PALETTES.dark.shimmers).toEqual({
    gold: { base: 0xd4a017, peak: 0xfff1a8 },
    text: { base: 0xb2b2b2, peak: 0xffffff },
    teal: { base: 0x00afaf, peak: 0xafffff },
    silver: { base: 0x9e9e9e, peak: 0xffffff },
    lavender: { base: 0xaf87d7, peak: 0xe4d7ff },
  })
  expect(PALETTES.light.shimmers).toEqual({
    gold: { base: 0xa67c00, peak: 0xe0b000 },
    text: { base: 0x6c6c6c, peak: 0x000000 },
    teal: { base: 0x008787, peak: 0x00d7d7 },
    silver: { base: 0x6c6c6c, peak: 0x262626 },
    lavender: { base: 0x8a63c7, peak: 0xb48cff },
  })
  expect([PALETTES.dark.heatQuick, PALETTES.dark.heatMedium, PALETTES.dark.heatHeavy]).toEqual([0x00afaf, 0xffaf00, 0xff5f00])
  expect([PALETTES.light.heatQuick, PALETTES.light.heatMedium, PALETTES.light.heatHeavy]).toEqual([0x00afaf, 0xd78700, 0xd75f00])
})

test('the settings: shimmer is gold unless it is one of its options, heat and foldAll are off unless "on"', () => {
  expect(DEFAULT_SETTINGS).toMatchObject({ shimmer: 'gold', heat: false, foldAll: false })
  expect(normalizeSettings({}).shimmer).toBe('gold')
  for (const s of ['gold', 'text', 'teal', 'silver', 'lavender', 'off']) expect(normalizeSettings({ shimmer: s }).shimmer).toBe(s)
  expect(normalizeSettings({ shimmer: 'pink' }).shimmer).toBe('gold')
  expect(normalizeSettings({ heat: 'on' }).heat).toBe(true)
  expect(normalizeSettings({ heat: 'off' }).heat).toBe(false)
  expect(normalizeSettings({ foldAll: 'on' }).foldAll).toBe(true)
  expect(normalizeSettings({ foldAll: 'x' }).foldAll).toBe(false)
})

// ---- the module's layout -----------------------------------------------------------------------

const rowsOf = (lines: ShineLine[], width: number): string[] => wrapShine(lines, width).map(cells => cells.map(c => c.ch).join('').trimEnd())

test('wrapShine: words wrap at the room, which starts at column 2 and takes width - 2', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve'
  const screen = wrapShine([plain([words, 0])], 30)
  expect(screen.map(cells => cells.map(c => c.ch).join('').trimEnd())).toEqual(['one two three four five six', 'seven eight nine ten eleven', 'twelve'])
  expect(screen.every(cells => cells[0]?.col === 2)).toBe(true)
  expect(screen.every(cells => cells.every(c => c.col + 1 <= 30))).toBe(true)
  expect(screen[0]?.[0]).toEqual({ ch: 'o', col: 2, flags: 0 })
})

test('wrapShine: a list item continues under its text, a long word breaks at the width', () => {
  const item: ShineLine = { kind: 'text', prefix: '- ', indent: 2, runs: [['alpha beta gamma delta epsilon zeta eta theta', 0]] }
  expect(rowsOf([item], 30)).toEqual(['- alpha beta gamma delta', '  epsilon zeta eta theta'])
  const long = wrapShine([plain(['x'.repeat(40), 0])], 30)
  expect(long.map(cells => cells.length)).toEqual([28, 12])
  expect(long[1]?.[0]?.col).toBe(2)
})

test('wrapShine: a rule fills the room, an empty line is one empty screen line, flags travel with the characters, wide ones take two cells', () => {
  const rule = wrapShine([{ kind: 'rule', prefix: '', indent: 0, runs: [] }], 30)
  expect(rule).toHaveLength(1)
  expect(rule[0]?.length).toBe(28)
  expect(rule[0]?.every(c => c.ch === '─')).toBe(true)
  expect(rule[0]?.[27]?.col).toBe(29)
  expect(wrapShine([plain(['a', 0]), BLANK, plain(['b', 0])], 30).map(cells => cells.length)).toEqual([1, 0, 1])
  expect(wrapShine([plain(['ab', 1], ['c', 2])], 30)[0]?.map(c => c.flags)).toEqual([1, 1, 2])
  expect(wrapShine([plain(['日本', 0])], 30)[0]?.map(c => c.col)).toEqual([2, 4])
})

// ---- the timeline and the colors ---------------------------------------------------------------

test('ease: 0 at 0, a half at a half, 1 at 1, clamped outside', () => {
  expect(ease(0)).toBe(0)
  expect(Math.abs(ease(0.5) - 0.5)).toBeLessThan(1e-6)
  expect(ease(1)).toBe(1)
  expect(ease(-1)).toBe(0)
  expect(ease(2)).toBe(1)
})

test('shineAmount: 0.3 s fade in, one glow (0.9 s up, 1.5 s down), a 0.5 s hold, 0.5 s fade out', () => {
  const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-6)
  expect(shineAmount(0)).toEqual({ tint: 0, glow: 0 })
  const at150 = shineAmount(150)
  near(at150.tint, 0.5)
  expect(at150.glow).toBe(0)
  expect(shineAmount(300)).toEqual({ tint: 1, glow: 0 })
  const at750 = shineAmount(750)
  expect(at750.tint).toBe(1)
  near(at750.glow, 0.5)
  expect(shineAmount(1200)).toEqual({ tint: 1, glow: 1 })
  const at1950 = shineAmount(1950)
  expect(at1950.tint).toBe(1)
  near(at1950.glow, 0.5)
  expect(shineAmount(2700)).toEqual({ tint: 1, glow: 0 })
  expect(shineAmount(3000)).toEqual({ tint: 1, glow: 0 })
  const at3450 = shineAmount(3450)
  near(at3450.tint, 0.5)
  expect(at3450.glow).toBe(0)
  expect(shineAmount(3700)).toEqual({ tint: 0, glow: 0 })
  expect(shineAmount(4500)).toEqual({ tint: 0, glow: 0 })
})

const PROPS: FolderShineProps = {
  kind: 'shine',
  turnId: 't1',
  age: 0,
  cols: 80,
  bullet: true,
  lines: [],
  text: 0xffffff,
  base: 0xd4a017,
  peak: 0xfff1a8,
  strength: 1,
}

test('shineColor: the text before and after, the tint at rest, the highlight at the glow\'s peak', () => {
  expect(shineColor({ tint: 0, glow: 0 }, PROPS)).toBe(PROPS.text)
  expect(shineColor({ tint: 1, glow: 0 }, PROPS)).toBe(PROPS.base)
  expect(shineColor({ tint: 0.5, glow: 0 }, PROPS)).toBe(mix(PROPS.text, PROPS.base, 0.5))
  expect(shineColor({ tint: 1, glow: 1 }, PROPS)).toBe(PROPS.peak)
  expect(shineColor({ tint: 1, glow: 0.5 }, PROPS)).toBe(mix(PROPS.base, PROPS.peak, 0.5))
  expect(shineColor({ tint: 1, glow: 1 }, { ...PROPS, strength: 0.5 })).toBe(mix(PROPS.base, PROPS.peak, 0.5))
})

test('the module repeats the timing numbers of motion.ts', () => {
  expect(client.TOTAL).toBe(SHINE_MS)
  expect(client.FADE_IN).toBe(SHINE_FADE_IN_MS)
  expect(client.RISE).toBe(SHINE_RISE_MS)
  expect(client.FALL).toBe(SHINE_FALL_MS)
  expect(client.FADE_OUT).toBe(SHINE_FADE_OUT_MS)
  expect(client.FRAME_MS).toBe(FRAME_MS)
  expect(SHINE_FADE_IN_MS + SHINE_RISE_MS + SHINE_FALL_MS + SHINE_HOLD_MS + SHINE_FADE_OUT_MS).toBe(SHINE_MS)
  expect(SHINE_MS).toBe(3700)
  expect(SHINE_HOLD_MS).toBe(500)
  expect(SHINE_STRENGTH).toEqual({ lively: 1, subtle: 0.5 })
})

// ---- effort and failure ------------------------------------------------------------------------

test('effortOf: quick under 3 tools and 30 s, heavy from 10 tools or 120 s, else medium', () => {
  expect(effortOf({ tools: 2, durationMs: 29_000 })).toBe('quick')
  expect(effortOf({ tools: 0, durationMs: null })).toBe('quick')
  expect(effortOf({ tools: 3, durationMs: 29_000 })).toBe('medium')
  expect(effortOf({ tools: 2, durationMs: 30_000 })).toBe('medium')
  expect(effortOf({ tools: 9, durationMs: 119_000 })).toBe('medium')
  expect(effortOf({ tools: 10, durationMs: 1000 })).toBe('heavy')
  expect(effortOf({ tools: 0, durationMs: 120_000 })).toBe('heavy')
})

test('isFailedTurn: interrupted, error, or at least one failed tool call', () => {
  expect(isFailedTurn({ status: 'done' })).toBe(false)
  expect(isFailedTurn({ status: 'done', failedTools: 0 })).toBe(false)
  expect(isFailedTurn({ status: 'running' })).toBe(false)
  expect(isFailedTurn({ status: 'done', failedTools: 1 })).toBe(true)
  expect(isFailedTurn({ status: 'interrupted' })).toBe(true)
  expect(isFailedTurn({ status: 'error' })).toBe(true)
})
