import type { Edge, FolderTurn, Marker, Style } from '../types'
import { BOX, DEFAULT, EDGES, MARKERS, displayWidth } from './cells'
import type { Cell, Palette } from './cells'
import { SEP, cutTo, formatDuration, statsParts } from './summary'
import type { StatPart } from './summary'

/** The least room a title keeps when the number and the stats share its line. */
const MIN_TITLE = 12
/** The least room the reply keeps on line 2 before it gives way to the stats. */
const MIN_REPLY = 8

/** One run of a header line's text, by role. */
export type TextPart = {
  text: string
  kind: 'title' | 'number' | 'stats' | 'fail' | 'branch' | 'reply'
  /** `null`: the terminal's default color. */
  fg: number | null
  /** `null`: no background. */
  bg: number | null
  bold: boolean
  dim: boolean
}

/**
 * One row of a header. `cells` always holds exactly `width` cells; under a line row's text region they are placeholders
 * (a space, the default foreground, the row's background). The whole row is drawn by the header's surface module (its lead
 * cells, its text parts, its tail cells); `press` is the part of row 0 that reacts to the pointer.
 */
export type HeaderRow = {
  kind: 'border' | 'line'
  cells: Cell[]
  text: { col: number; width: number; parts: TextPart[]; line: 1 | 2 | 3 } | null
  /** The columns that are pressable: the marker, its space and the turn number, on row 0; null on every other row. */
  press: { col: number; width: number } | null
}

/** The header of one turn as a model: the render draws it and the motion animates it. */
export type HeaderModel = {
  style: Style
  folded: boolean
  width: number
  rows: HeaderRow[]
  /** The cell of the fold marker. */
  marker: { row: number; col: number }
  /** The background of lead, text and tail in the rail and zebra styles; null elsewhere. */
  band: number | null
  /** The color of the card's border (boxed) or of the rule (rules); null elsewhere. */
  frame: number | null
}

export type HeaderInput = {
  turn: Pick<FolderTurn, 'n' | 'title' | 'reply' | 'tools' | 'files' | 'durationMs' | 'status'>
  style: Style
  lines: 1 | 2 | 3
  marker: Marker
  edge: Edge
  palette: Palette
  columns: number
  folded: boolean
}

/** The zebra band's rounded ends: the right half block closes its left side, the left half block its right side. */
const CAP_LEFT = 0x2590
const CAP_RIGHT = 0x258c

const widthOf = (parts: readonly TextPart[]): number => parts.reduce((sum, p) => sum + displayWidth(p.text), 0)

const space = (bg: number): Cell => ({ cp: 0x20, fg: DEFAULT, bg })

const glyph = (cp: number, fg: number, bg: number): Cell => ({ cp, fg, bg })

/** What the text parts of one header need to know. */
type Ctx = {
  turn: HeaderInput['turn']
  style: Style
  palette: Palette
  folded: boolean
  /** The cells a line's text may take. */
  room: number
  /** The row's band, or null when the style has none. */
  bg: number | null
}

const part = (
  ctx: Ctx,
  text: string,
  kind: TextPart['kind'],
  fg: number | null,
  o: { bold?: boolean; dim?: boolean } = {},
): TextPart => ({ text, kind, fg, bg: ctx.bg, bold: o.bold === true, dim: o.dim === true })

/** `stats` as parts: each stat after a ` · `, except that the first one's separator is left out when `firstSep` is false. */
function joinStats(ctx: Ctx, stats: readonly StatPart[], firstSep: boolean): TextPart[] {
  const out: TextPart[] = []
  stats.forEach((s, i) => {
    if (i > 0 || firstSep) out.push(part(ctx, SEP, 'stats', ctx.palette.figures))
    out.push(part(ctx, s.text, s.isFail ? 'fail' : 'stats', s.isFail ? ctx.palette.fail : ctx.palette.figures))
  })

  return out
}

/** The turn's stats as parts, as the style shows them (the rules style leaves the time to its rule). */
const statParts = (ctx: Ctx, firstSep: boolean): TextPart[] => joinStats(ctx, statsParts(ctx.turn, ctx.style !== 'rules'), firstSep)

/**
 * Line 1 of a folded header: the title, and with one line the stats. Rail and zebra carry the marker in their lead and
 * start the text with the number (`#3 · title`); boxed and rules hold the marker and the number on row 0 instead.
 */
function lineOneParts(ctx: Ctx, lines: 1 | 2 | 3): TextPart[] {
  const before: TextPart[] =
    ctx.style === 'rail' || ctx.style === 'zebra'
      ? [...numberParts(ctx), part(ctx, SEP, 'stats', ctx.palette.figures)]
      : []
  const after: TextPart[] = []
  if (lines === 1) {
    const stats = statParts(ctx, true)
    if (ctx.room - widthOf(before) - widthOf(stats) >= MIN_TITLE) after.push(...stats)
  }
  const title = cutTo(ctx.turn.title, ctx.room - widthOf(before) - widthOf(after))

  return [
    ...before,
    part(ctx, title, 'title', ctx.folded ? ctx.palette.title : ctx.palette.titleOpen, { bold: true }),
    ...after,
  ]
}

/** The turn number, bold: in the figures color when folded, in the title's open color when open. */
function numberParts(ctx: Ctx): TextPart[] {
  return [part(ctx, '#' + ctx.turn.n, 'number', ctx.folded ? ctx.palette.figures : ctx.palette.titleOpen, { bold: true })]
}

/** Line 2 of a folded header: the branch, the reply, the stats; null when there is neither a reply nor stats. */
function lineTwoParts(ctx: Ctx): TextPart[] | null {
  const stats = statsParts(ctx.turn, ctx.style !== 'rules')
  if (ctx.turn.reply === '' && stats.length === 0) return null
  const parts: TextPart[] = [part(ctx, '└ ', 'branch', ctx.palette.branch)]
  let withSep = false
  if (ctx.turn.reply !== '') {
    const avail = ctx.room - 2 - widthOf(statParts(ctx, true))
    if (avail >= MIN_REPLY) {
      parts.push(part(ctx, cutTo(ctx.turn.reply, avail), 'reply', null, { dim: true }))
      withSep = true
    }
  }
  let rest = statParts(ctx, withSep)
  if (widthOf(rest) > ctx.room - 2) {
    rest = [part(ctx, cutTo(stats.map(s => s.text).join(SEP), ctx.room - 2), 'stats', ctx.palette.figures)]
  }

  return [...parts, ...rest]
}

/** Line 2 of a three-line header: the branch and the first line of the answer, with the whole width. */
function lineTwoOfThree(ctx: Ctx): TextPart[] {
  return [
    part(ctx, '├ ', 'branch', ctx.palette.branch),
    part(ctx, cutTo(ctx.turn.reply, ctx.room - 2), 'reply', null, { dim: true }),
  ]
}

/**
 * Line 3 of a three-line header: the branch and the stats, with the edited files named when they fit; else the short form
 * of the files line 2 uses, else the joined stats cut with `…`.
 */
function lineThreeOfThree(ctx: Ctx): TextPart[] {
  const withDuration = ctx.style !== 'rules'
  const room = ctx.room - 2
  let stats = statsParts(ctx.turn, withDuration, true)
  if (widthOf(joinStats(ctx, stats, false)) > room) stats = statsParts(ctx.turn, withDuration, false)
  let rest = joinStats(ctx, stats, false)
  if (widthOf(rest) > room) {
    rest = [part(ctx, cutTo(stats.map(s => s.text).join(SEP), room), 'stats', ctx.palette.figures)]
  }

  return [part(ctx, '└ ', 'branch', ctx.palette.branch), ...rest]
}

/** How one style lays out its line rows. */
type Layout = {
  lead1: () => Cell[]
  lead2: () => Cell[]
  /** The cells a line's text may take. */
  room: number
  /** The background of lead, text and tail; null for none. */
  bg: number | null
  /** The last cell of a line, when the style closes it (the card's right border). */
  close: (() => Cell) | null
}

function lineRow(lay: Layout, lead: Cell[], parts: TextPart[], line: 1 | 2 | 3, W: number): HeaderRow {
  const bg = lay.bg ?? DEFAULT
  const col = lead.length
  const width = widthOf(parts)
  const rest = Math.max(0, W - col - width)
  const cells = [...lead]
  for (let i = 0; i < width; i++) cells.push(space(bg))
  for (let i = 0; i < rest; i++) cells.push(space(bg))
  if (lay.close !== null && rest > 0) cells[cells.length - 1] = lay.close()

  return { kind: 'line', cells, text: { col, width, parts, line }, press: null }
}

/** The open card's bottom border, drawn by the turn's closer row: `╰`, `─` × (W − 2), `╯` in the open card's color. */
export function cardBottom(W: number, palette: Palette): Cell[] {
  const cells = [glyph(BOX.bl, palette.frameOpen, DEFAULT)]
  for (let i = 0; i < W - 2; i++) cells.push(glyph(BOX.h, palette.frameOpen, DEFAULT))
  cells.push(glyph(BOX.br, palette.frameOpen, DEFAULT))

  return cells
}

/** The header of one turn, per style; see the plan's table. */
export function buildHeader(input: HeaderInput): HeaderModel {
  const { turn, style, lines, marker, edge, palette, folded } = input
  const W = Math.max(20, Math.min(512, input.columns) - 2)
  const glyphs = MARKERS[marker]
  const mkCp = folded ? glyphs.folded : glyphs.open
  const mkFg = folded ? palette.marker : palette.markerOpen
  // Boxed and rules share the frame colors: teal folded, grey open.
  const frameColor = folded ? palette.frame : palette.frameOpen

  let lay: Layout
  if (style === 'rail') {
    const bg = folded ? palette.band : palette.bandOpen
    const edgeCell = (): Cell => glyph(EDGES[edge], palette.rail, bg)
    lay = {
      lead1: () => [edgeCell(), space(bg), glyph(mkCp, mkFg, bg), space(bg)],
      lead2: () => [edgeCell(), space(bg), space(bg), space(bg)],
      room: W - 4,
      bg,
      close: null,
    }
  } else if (style === 'zebra') {
    const bg = folded ? (turn.n % 2 === 1 ? palette.zebraA : palette.zebraB) : palette.bandOpen
    // The band's rounded ends are glyphs in the band color on the terminal's background; the band itself covers the cells between.
    lay = {
      lead1: () => [glyph(CAP_LEFT, bg, DEFAULT), glyph(mkCp, mkFg, bg), space(bg)],
      lead2: () => [glyph(CAP_LEFT, bg, DEFAULT), space(bg), space(bg)],
      room: W - 4,
      bg,
      close: () => glyph(CAP_RIGHT, bg, DEFAULT),
    }
  } else if (style === 'boxed') {
    // The card's marker and number sit on its top border (row 0); the rows below hold the title and the answer only.
    const v = (): Cell => glyph(BOX.v, frameColor, DEFAULT)
    lay = {
      lead1: () => [v(), space(DEFAULT)],
      lead2: () => [v(), space(DEFAULT)],
      room: W - 4,
      bg: null,
      close: v,
    }
  } else {
    // The rule holds the marker and the number (row 0); the rows below are plain.
    lay = {
      lead1: () => [space(DEFAULT), space(DEFAULT), space(DEFAULT)],
      lead2: () => [space(DEFAULT), space(DEFAULT), space(DEFAULT)],
      room: W - 3,
      bg: null,
      close: null,
    }
  }

  const ctx: Ctx = { turn, style, palette, folded, room: lay.room, bg: lay.bg }
  const hLine = (): Cell => glyph(BOX.h, frameColor, DEFAULT)
  const rows: HeaderRow[] = []
  const border = (cells: Cell[]): HeaderRow => ({ kind: 'border', cells, text: null, press: null })

  // Row 0 holds the marker and the turn number in every style, folded or open: the one spot that reacts to the pointer.
  const markerRow = 0
  let markerCol = style === 'zebra' ? 1 : 2
  if (style === 'boxed' || style === 'rules') {
    // The border (or the rule) holding the marker and the turn number, and for a folded rule its time; the card or the rule
    // runs on to the edge.
    const boxed = style === 'boxed'
    const lead: Cell[] = boxed
      ? [glyph(BOX.tl, frameColor, DEFAULT), hLine(), space(DEFAULT), glyph(mkCp, mkFg, DEFAULT), space(DEFAULT)]
      : [hLine(), hLine(), hLine(), space(DEFAULT), glyph(mkCp, mkFg, DEFAULT), space(DEFAULT)]
    markerCol = lead.length - 2
    const parts =
      folded && !boxed && turn.durationMs !== null
        ? [...numberParts(ctx), part(ctx, SEP + formatDuration(turn.durationMs), 'stats', palette.figures)]
        : numberParts(ctx)
    const width = widthOf(parts)
    const cells = [...lead]
    for (let i = 0; i < width; i++) cells.push(space(DEFAULT))
    const rest = Math.max(0, W - lead.length - width)
    if (rest > 0) {
      cells.push(space(DEFAULT))
      // The card ends in its right corner; the rule runs on to the edge.
      const dashes = boxed ? rest - 2 : rest - 1
      for (let i = 0; i < dashes; i++) cells.push(hLine())
      if (boxed && rest > 1) cells.push(glyph(BOX.tr, frameColor, DEFAULT))
    }
    rows.push({ kind: 'line', cells, text: { col: lead.length, width, parts, line: 1 }, press: null })
  } else if (!folded) {
    rows.push(lineRow(lay, lay.lead1(), numberParts(ctx), 1, W))
  } else {
    // Rail and zebra: the marker and the number come first on line 1.
    rows.push(lineRow(lay, lay.lead1(), lineOneParts(ctx, lines), 1, W))
  }
  if (folded) {
    // Boxed and rules: row 0 held the marker and the number, so the title is line 1 on the row below.
    if (style === 'boxed' || style === 'rules') rows.push(lineRow(lay, lay.lead1(), lineOneParts(ctx, lines), 1, W))
    if (lines >= 2) {
      // Three lines split the summary into the answer and the stats; with only one of them, it is the two-line layout.
      if (lines === 3 && turn.reply !== '' && statsParts(turn, style !== 'rules').length > 0) {
        rows.push(lineRow(lay, lay.lead2(), lineTwoOfThree(ctx), 2, W))
        rows.push(lineRow(lay, lay.lead2(), lineThreeOfThree(ctx), 3, W))
      } else {
        const second = lineTwoParts(ctx)
        if (second !== null) rows.push(lineRow(lay, lay.lead2(), second, 2, W))
      }
    }
  }
  if (style === 'boxed' && folded) {
    const bottom = [glyph(BOX.bl, frameColor, DEFAULT)]
    for (let i = 0; i < W - 2; i++) bottom.push(hLine())
    bottom.push(glyph(BOX.br, frameColor, DEFAULT))
    rows.push(border(bottom))
  }

  // What reacts to the pointer: the marker, its space and the turn number, on row 0 (the number is its first text part).
  // Every other row (the title, the answer, the stats, a border) does not.
  const top = rows[markerRow]
  const number = top?.text?.parts[0]
  if (top !== undefined && top.text !== null && number !== undefined) {
    top.press = { col: markerCol, width: top.text.col - markerCol + displayWidth(number.text) }
  }

  return {
    style,
    folded,
    width: W,
    rows,
    marker: { row: markerRow, col: markerCol },
    band: style === 'rail' || style === 'zebra' ? lay.bg : null,
    frame: style === 'boxed' || style === 'rules' ? frameColor : null,
  }
}

/**
 * The cells the outline light runs along, as `[row, col]` in travel order, and whether the path closes on itself. Boxed
 * folded: the card's whole perimeter, clockwise from its top-left corner. Boxed open: its top line outside the number.
 * Rail: the edge bar's cell of each header line. Rules: the rule, outside the text (the number, and a folded rule's time).
 * Zebra: the band's two caps, up the left and down the right.
 */
export function outlineOf(model: HeaderModel): { path: [number, number][]; cyclic: boolean } {
  const W = model.width
  const R = model.rows.length
  const path: [number, number][] = []
  if (model.style === 'boxed' && model.folded) {
    for (let c = 0; c < W; c++) path.push([0, c])
    for (let r = 1; r <= R - 2; r++) path.push([r, W - 1])
    for (let c = W - 1; c >= 0; c--) path.push([R - 1, c])
    for (let r = R - 2; r >= 1; r--) path.push([r, 0])

    return { path, cyclic: true }
  }
  if (model.style === 'boxed' || model.style === 'rules') {
    // Open boxed: the top line; rules: the rule; both outside row 0's text region (the number, and a folded rule's time).
    const text = model.rows[0]?.text
    for (let c = 0; c < W; c++) {
      if (text === null || text === undefined || c < text.col || c >= text.col + text.width) path.push([0, c])
    }

    return { path, cyclic: false }
  }
  const lineRows = model.rows.flatMap((row, r) => (row.kind === 'line' ? [r] : []))
  if (model.style === 'rail') return { path: lineRows.map((r): [number, number] => [r, 0]), cyclic: false }
  for (const r of [...lineRows].reverse()) path.push([r, 0])
  for (const r of lineRows) path.push([r, W - 1])

  return { path, cyclic: true }
}
