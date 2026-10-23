import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { GOLD, hex, mixColor } from '../hooks/cells'
import { normalizeSettings } from '../hooks/settings'
import type { FolderHeadProps } from '../types'

/** What the engine draws beneath the mod, for every component. */
const ENGINE = 'ENGINE'

const VIEWPORT = { columns: 100, rows: 40, isFullscreen: true } as const

type Node = { type?: string; props?: Record<string, unknown>; hover?: unknown; children?: unknown[] }

/** The engine beneath the mod: every component draws ENGINE, tools and turns answer. */
function world(on: On) {
  /** Every write the mod made to its state, in order: the member's key and its value. */
  const writes: { key: string; value: unknown }[] = []
  /** Every line the mod logged, in order (the debug lines of its filing decisions among them). */
  const logs: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.log', (_$, e, next) => {
    logs.push(e.text)

    return next(e)
  })
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin?: string; key?: string; value?: unknown }
    if (write.plugin === 'claudefolder' && typeof write.key === 'string') writes.push({ key: write.key, value: write.value })

    return next(e)
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_$, e) => {
    const call = e as unknown as { tool?: string; tool_use_id?: string }

    return { result: call.tool === 'Agent' ? { status: 'async_launched', isAsync: true, agentId: 'agent-' + String(call.tool_use_id) } : 'ok' } as never
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.render', ({ ui }, e) => {
    const { Text } = ui.resolve(e)
    return <Text>{ENGINE}</Text>
  })

  return { writes, logs, clock }
}

const keyOf = (n: Node): string => String(n.props?.key ?? (n as { key?: unknown }).key)

/** The text a tree reads as; the absolutely placed edge bar of an open turn's rows is left out. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const one = node as Node
  if (one.props?.position === 'absolute' || one.props?.height === 1) return ''
  return (one.children ?? []).map(textOf).join('')
}

function walk(node: unknown, out: Node[] = []): Node[] {
  if (node === null || typeof node !== 'object') return out
  out.push(node as Node)
  for (const child of (node as Node).children ?? []) walk(child, out)
  return out
}

const rasters = (node: unknown): Node[] => walk(node).filter(n => n.type === 'Raster')

const clients = (node: unknown): Node[] => walk(node).filter(n => n.type === 'Client')

const buttons = (node: unknown): Node[] => walk(node).filter(n => n.type === 'Button')

/** Every node with a hover scope. */
const scoped = (node: unknown): Node[] =>
  walk(node).filter(n => typeof n.hover === 'object' && n.hover !== null && 'scope' in (n.hover as object))

/** The gap line of a drawn header: a Box one line tall that holds at most one Text of a single space (no bar). */
const gapOf = (node: unknown): Node | undefined =>
  walk(node).find(
    n =>
      n.type === 'Box' &&
      n.props?.height === 1 &&
      (n.children ?? []).every(c => typeof c === 'object' && c !== null && (c as Node).type === 'Text' && textOf(c) === ' '),
  )

/** The Text inside the absolutely placed Box of a drawn tree (the edge bar of an open turn's rows), if there is one. */
const railOf = (node: unknown): Node | undefined => {
  const box = walk(node).find(n => n.props?.position === 'absolute')
  return box === undefined ? undefined : walk(box).find(n => n.type === 'Text')
}

/** Box props the engine refuses on any ancestor of its own node. */
const CONCEALING = ['display', 'overflow', 'position', 'width', 'height', 'minWidth', 'minHeight', 'top', 'left', 'right', 'bottom']

/** Every concealing prop set on a Box above the engine's `ENGINE` Text in a drawn tree (the path from the root to it). */
function concealers(node: unknown, path: string[] = []): string[] | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const one = node as Node
  if (one.type === 'Text' && (one.children ?? []).includes(ENGINE)) return path
  const here =
    one.type === 'Box' ? CONCEALING.filter(p => one.props?.[p] !== undefined).map(p => 'Box ' + p) : []
  for (const child of one.children ?? []) {
    const found = concealers(child, [...path, ...here])
    if (found !== undefined) return found
  }

  return undefined
}

const sp = (k: number): string => ' '.repeat(k)

/** The edge bar's text: `glyph` on 400 lines. */
const railText = (glyph: string): string => Array.from({ length: 400 }, () => glyph).join('\n')

/** The Button keyed `key` in a drawn tree: its `hover` sits beside `props` on the node, not inside them. */
const buttonOf = (node: unknown, key: string): Node | undefined => walk(node).find(n => n.type === 'Button' && n.props?.key === key)

// ---- the header Client ---------------------------------------------------------------------

/** The key of turn `n`'s header Client. */
const head = (n: number): string => 'folder-head-' + n

/** A mounted drawing as far as these helpers read it. */
type Drawer = { drawn: (scope?: { in?: string }) => Promise<unknown> }
type Pointer = {
  pointer: (e: { type: 'down' | 'move' | 'up' | 'enter' | 'leave'; x: number; y: number; button?: 'left'; in?: string }) => Promise<void>
}

/** The text of a tree with each Client's text read from what its surface module drew (absolute nodes skipped as before). */
function textWith(node: unknown, modules: Map<string, unknown>): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const one = node as Node
  if (one.props?.position === 'absolute' || one.props?.height === 1) return ''
  if (one.type === 'Client') return textOf(modules.get(keyOf(one)))
  return (one.children ?? []).map(c => textWith(c, modules)).join('')
}

async function fullText(ui: Drawer): Promise<string> {
  const tree = await ui.drawn()
  const modules = new Map<string, unknown>()
  for (const c of clients(tree)) modules.set(keyOf(c), await ui.drawn({ in: keyOf(c) }))
  return textWith(tree, modules)
}

/** A press and its release on the same cell of a Client. */
async function click(ui: Pointer, key: string, x: number, y: number): Promise<void> {
  await ui.pointer({ type: 'down', x, y, button: 'left', in: key })
  await ui.pointer({ type: 'up', x, y, button: 'left', in: key })
}

const hoverAt = (ui: Pointer, key: string, x: number, y: number): Promise<void> => ui.pointer({ type: 'move', x, y, in: key })

const leave = (ui: Pointer, key: string): Promise<void> => ui.pointer({ type: 'leave', x: 0, y: 0, in: key })

type Run = { text: string; color: unknown; bg: unknown; bold: unknown; dim: unknown }

/** The Text runs of a tree: the Text nodes that hold only strings, in order. */
const runsOf = (node: unknown): Run[] =>
  walk(node)
    .filter(n => n.type === 'Text' && (n.children ?? []).length > 0 && (n.children ?? []).every(c => typeof c === 'string'))
    .map(n => ({
      text: (n.children ?? []).join(''),
      color: n.props?.color,
      bg: n.props?.backgroundColor,
      bold: n.props?.bold,
      dim: n.props?.dimColor,
    }))

/** The runs of what the header module drew. */
const moduleRuns = async (ui: Drawer, key: string): Promise<Run[]> => runsOf(await ui.drawn({ in: key }))

/** The module's rows, each as text. */
const moduleRows = async (ui: Drawer, key: string): Promise<string[]> =>
  (((await ui.drawn({ in: key })) as Node).children ?? []).map(textOf)

/** The runs of row `r` of the module. */
const rowRuns = async (ui: Drawer, key: string, r: number): Promise<Run[]> =>
  runsOf((((await ui.drawn({ in: key })) as Node).children ?? [])[r])

/** The style of every cell of the module's rows (colors, background, bold, dim), row by row. */
const cellStyles = async (ui: Drawer, key: string): Promise<string[][]> =>
  (((await ui.drawn({ in: key })) as Node).children ?? []).map(row =>
    runsOf(row).flatMap(r => Array.from(r.text).map(() => [r.color, r.bg, r.bold, r.dim].join('|'))),
  )

/** The cells whose style differs between two `cellStyles`, as `[row, col]`. */
function differing(a: string[][], b: string[][]): [number, number][] {
  const out: [number, number][] = []
  a.forEach((row, r) => row.forEach((s, c) => s !== b[r]?.[c] && out.push([r, c])))
  return out
}

/** The text of the runs colored `color`, joined. */
const coloredText = (runs: Run[], color: string): string => runs.filter(r => r.color === color).map(r => r.text).join('')

type Ticker = Drawer & { advance: (ms: number) => Promise<void> }

/**
 * Watches the header's outline light for `frames` frames of 50 ms, `each` running before every frame: how many times a
 * lap starts (a frame where some outline cell is lit after a frame where none is) and how many frames have a lit cell.
 * A cell is lit when its style differs from the last frame's, which the caller leaves at rest. The cells of the press range
 * (the marker and the number) are left out: a pointer on them tints them, which is no light.
 * One lap shows no light for a frame or two while it passes over cells that cannot show it (the press range, and the
 * uncolored spaces round it on the card's top border): up to `LAP_GAP` dark frames between lit ones belong to the same lap
 * and count in `litFrames`. A second lap would add its own 40 lit frames, so `litFrames` still tells one lap from two.
 */
const LAP_GAP = 2

async function lapStarts(ui: Ticker, key: string, frames: number, each?: () => Promise<void>): Promise<{ starts: number; litFrames: number }> {
  const props = clients(await ui.drawn())[0]?.props?.props as FolderHeadProps
  const outline = props.outline.filter(([r, c]) => !props.press.some(([pr, pc, pw]) => pr === r && c >= pc && c < pc + pw))
  const samples = [await cellStyles(ui, key)]
  for (let i = 0; i < frames; i++) {
    if (each !== undefined) await each()
    await ui.advance(50)
    samples.push(await cellStyles(ui, key))
  }
  const rest = samples[samples.length - 1]!
  let last = -1000
  let starts = 0
  let litFrames = 0
  samples.forEach((s, i) => {
    if (!outline.some(([r, c]) => s[r]?.[c] !== rest[r]?.[c])) return
    if (i - last > LAP_GAP + 1) {
      starts += 1
      litFrames += 1
    } else {
      litFrames += i - last
    }
    last = i
  })

  return { starts, litFrames }
}

// ---- the rows a transcript is made of ------------------------------------------------------

const append = (
  $: Engine,
  uuid: string,
  door: string,
  type: string,
  content: unknown[],
  agentId?: string,
  name?: string,
  isMeta = false,
  origin?: string,
) =>
  $.session.append({
    message: { type, content, ...(name === undefined ? {} : { name }), ...(isMeta ? { isMeta: true } : {}) },
    door,
    origin: door === 'response' ? { kind: 'model', model: 'claude-opus-5-5' } : { kind: origin ?? 'composer' },
    uuid,
    ...(agentId === undefined ? {} : { agentId }),
  } as never)

type TurnOptions = {
  text?: string
  answer?: string
  reason?: 'answer' | 'aborted' | 'error'
  durationMs?: number
  /** Skips the duration notice: a turn that ends on its last reply. */
  noDuration?: boolean
}

/**
 * One finished main-loop turn `i`: the prompt `u<i>`, a response with a tool call `toolu_<i>` (row `a<i>`), the call
 * itself (an edit of auth.ts), its result row `r<i>`, the answer row `b<i>`, the turn's end and the duration notice `d<i>`.
 */
async function runTurn($: Engine, i: number, o: TurnOptions = {}) {
  const text = o.text ?? 'fix the login'
  const answer = o.answer ?? 'Fixed it.'
  const reason = o.reason ?? 'answer'
  const turnId = 't' + i
  await append($, 'u' + i, 'prompt', 'user', [{ type: 'text', text }])
  await $.turn.start({ text, turnId } as never)
  await append($, 'a' + i, 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_' + i, name: 'Edit', input: {} }])
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\src\\auth.ts' } as never)
  await append($, 'r' + i, 'tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_' + i, content: 'ok' }])
  await append($, 'b' + i, 'response', 'assistant', [{ type: 'text', text: answer }])
  await $.turn.complete({ answer, durationMs: o.durationMs ?? 41_000, isAborted: reason === 'aborted', turnId, reason } as never)
  if (o.noDuration !== true) await append($, 'd' + i, 'notice', 'system', [{ type: 'text', text: 'Baked for 41s' }], undefined, 'turn_duration')
}

/** Turn `i` launches one background agent (`agent-toolu_bg<i>`) and ends on its reply `b<i>` and duration line `d<i>`. */
async function runAgentTurn($: Engine, i: number) {
  const turnId = 't' + i
  await append($, 'u' + i, 'prompt', 'user', [{ type: 'text', text: 'start an agent' }])
  await $.turn.start({ text: 'start an agent', turnId } as never)
  await append($, 'a' + i, 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_bg' + i, name: 'Agent', input: {} }])
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_bg' + i, description: 'x', prompt: 'y' } as never)
  await append($, 'r' + i, 'tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_bg' + i, content: 'ok' }])
  await append($, 'b' + i, 'response', 'assistant', [{ type: 'text', text: 'Started.' }])
  await $.turn.complete({ answer: 'Started.', durationMs: 3000, isAborted: false, turnId, reason: 'answer' } as never)
  await append($, 'd' + i, 'notice', 'system', [{ type: 'text', text: 'Baked for 3s' }], undefined, 'turn_duration')
}

type Viewport = { columns: number; rows: number; isFullscreen?: boolean }

const user = ($: Engine, requestId: string, props: Record<string, unknown> = {}, viewport: Viewport = VIEWPORT) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text: 'x', origin: { kind: 'composer' }, isExpanded: false, ...props } as never,
    viewport,
  })

const assistant = ($: Engine, requestId: string, props: Record<string, unknown> = {}) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'Fixed it.', isFirstOfReply: true, ...props } as never,
    viewport: VIEWPORT,
  })

const toolUse = ($: Engine, id: string, props: Record<string, unknown> = {}) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false, ...props } as never,
    viewport: VIEWPORT,
  })

const toolResult = ($: Engine, id: string, props: Record<string, unknown> = {}) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: 'Edit', output: 'ok', isErrored: false, ...props } as never,
    viewport: VIEWPORT,
  })

const group = ($: Engine, requestId: string, callIds: string[]) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'ToolGroup',
    requestId,
    props: {
      calls: callIds.map(id => ({ tool_use_id: id, tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false })),
      isActive: false,
      isExpanded: false,
    } as never,
    viewport: VIEWPORT,
  })

const duration = ($: Engine, requestId: string, durationMs: number, props: Record<string, unknown> = {}) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId,
    props: { word: 'Baked', durationMs, ...props } as never,
    viewport: VIEWPORT,
  })

/** `/folder <args>`, as the composer runs it. */
const folder = ($: Engine, args: string, isFullscreen = true) =>
  $.command.run({
    command: 'folder',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen, columns: 100 },
  } as never) as Promise<{ text: string }>

type Poster = { post: (data: { type: string }, scope?: { in?: string }) => Promise<void> }

/**
 * The header Client of turn `n` fails on its surface, for real: the mod answers this post with props the module cannot
 * draw, the module throws, and the engine tells the plugin's `ui.fault` hook (the test engine cannot raise that itself).
 */
const fault = (ui: Poster, n: number): Promise<void> => ui.post({ type: 'fault' }, { in: head(n) }).catch(() => undefined)

// ---- what the headers read as --------------------------------------------------------------

/** A folded turn 1 in the rail style at 100 columns: two lines of 98 cells. */
const FOLDED_1 = '▌ ▸ #1 · fix the login' + sp(76) + '▌   └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(51)
/** Its open header: one line, the marker and the number alone. */
const OPEN_1 = '▌ ▾ #1' + sp(92)

const still = { options: { motion: 'off' } } as const

test('the running turn draws as the engine does, and so does a row nobody has claimed', still, async ($, on) => {
  world(on)
  await append($, 'u1', 'prompt', 'user', [{ type: 'text', text: 'fix the login' }])
  const u1 = await user($, 'u1')
  expect(textOf(await u1.drawn())).toBe(ENGINE)
  await $.turn.start({ text: 'fix the login', turnId: 't1' } as never)
  await append($, 'a1', 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }])
  await u1.redraw()
  expect(textOf(await u1.drawn())).toBe(ENGINE)
  expect(railOf(await u1.drawn())).toBeUndefined()
  expect(gapOf(await u1.drawn())).toBeUndefined()
  const call = await toolUse($, 'toolu_1')
  expect(textOf(await call.drawn())).toBe(ENGINE)
  expect(railOf(await call.drawn())).toBeUndefined()
  expect(textOf(await (await assistant($, 'nobody')).drawn())).toBe(ENGINE)
})

test('the newest finished turn shows the open header above the engine row, with the bar down its rows', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  const open = await u1.drawn()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  expect(gapOf(open)).toBeDefined()
  // The open header shows no title: the number takes its place, bold in the title's open color.
  const runs = await moduleRuns(u1, head(1))
  expect(runs.some(r => r.text === 'fix the login')).toBe(false)
  const number = runs.filter(r => r.text === '#1')
  expect(number.some(t => t.bg === '#26243a' && t.color === '#8a8a8a' && t.bold === true)).toBe(true)
  const b1 = await (await assistant($, 'b1')).drawn()
  expect(textOf(b1)).toBe(ENGINE)
  const rail = railOf(b1)
  expect(rail?.props?.color).toBe('#00afaf')
  expect(rail?.hover).toBeUndefined()
  expect(textOf(rail)).toBe(railText('▌'))
})

test('under next, the second prompt folds the first turn into two lines and hides its rows', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  const b1 = await assistant($, 'b1')
  const call = await toolUse($, 'toolu_1')
  const out = await toolResult($, 'toolu_1')
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  await runTurn($, 2)
  for (const ui of [u1, b1, call, out]) await ui.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
  expect(railOf(await u1.drawn())).toBeUndefined()
  expect(gapOf(await u1.drawn())).toBeDefined()
  for (const ui of [b1, call, out]) {
    const drawn = await ui.drawn()
    expect(drawn).toMatchObject({ type: 'Box' })
    expect(textOf(drawn)).toBe('')
    expect(railOf(drawn)).toBeUndefined()
  }
  // Turn 2 is the newest finished turn: its open header and its bar.
  const u2 = await user($, 'u2')
  expect(await fullText(u2)).toBe(OPEN_1.replace('#1', '#2') + ENGINE)
})

test('the duration line of a folded turn hides with it, found by its row; a duration row nobody filed draws as the engine does', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2, { durationMs: 7_000 })
  await user($, 'u1')
  expect(textOf(await (await duration($, 'd1', 41_000)).drawn())).toBe('')
  expect(textOf(await (await duration($, 'unseen', 41_500)).drawn())).toBe(ENGINE)
  expect(textOf(await (await duration($, 'other', 99_000)).drawn())).toBe(ENGINE)
})

test('a press on the folded marker and number opens the turn, and a press on the same spot folds it again', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  const b1 = await assistant($, 'b1')
  expect(await fullText(u1)).toBe(FOLDED_1)
  await click(u1, head(1), 2, 0)
  await u1.redraw()
  await b1.redraw()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  expect(textOf(await b1.drawn())).toBe(ENGINE)
  expect(railOf(await b1.drawn())?.props?.color).toBe('#00afaf')
  await click(u1, head(1), 2, 0)
  await u1.redraw()
  await b1.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
  expect(textOf(await b1.drawn())).toBe('')
  expect(railOf(await b1.drawn())).toBeUndefined()
  // The title and the reply line do not react.
  await click(u1, head(1), 12, 0)
  await click(u1, head(1), 6, 1)
  await u1.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
  await click(u1, head(1), 5, 0)
  await u1.redraw()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  // On the open header only `▾ #1` reacts: the band to its right does nothing.
  await click(u1, head(1), 20, 0)
  await click(u1, head(1), 6, 0)
  await u1.redraw()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  await click(u1, head(1), 5, 0)
  await u1.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
})

test('a turn the user opened stays open when the next prompt comes', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await click(u1, head(1), 2, 0)
  await runTurn($, 3)
  await u1.redraw()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
})

test('rail: two open turns in a row keep a gap line with no bar between them', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await click(u1, head(1), 2, 0)
  await u1.redraw()
  const d1 = await (await duration($, 'd1', 41_000)).drawn()
  const u2 = await (await user($, 'u2')).drawn()
  // Turn 1 is open: its last row (the duration line) has the bar down it.
  expect(textOf(railOf(d1))).toBe(railText('▌'))
  // Turn 2 is open too: its header column starts with the gap line, then the header, then its own railed rows.
  const column = ((u2 as Node).children ?? [])[0] as Node
  const gap = (column.children ?? [])[0] as Node
  expect(gap).toBe(gapOf(u2))
  expect(gap.props?.height).toBe(1)
  // The gap line draws a blank and holds no bar; the only bar of the row comes after it, beside the engine row.
  expect(walk(gap).filter(n => n.props?.position === 'absolute')).toEqual([])
  expect(walk(gap).filter(n => n.type === 'Text').map(n => n.children)).toEqual([[' ']])
  const nodes = walk(u2)
  const firstBar = nodes.findIndex(n => n.props?.position === 'absolute')
  expect(firstBar).toBeGreaterThan(nodes.indexOf(gap))
  expect(nodes.filter(n => n.props?.position === 'absolute').length).toBe(1)
  expect(railOf(u2)?.props?.color).toBe('#00afaf')
})

test('ctrl+o and --verbose draw every row', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  // The view is read from the duration lines: once one has drawn expanded, every row draws in full.
  const d1 = await duration($, 'd1', 41_000, { isExpanded: true })
  expect(textOf(await d1.drawn())).toBe(ENGINE)
  const u1 = await user($, 'u1', { isExpanded: true })
  expect(textOf(await u1.drawn())).toBe(ENGINE)
  expect(railOf(await u1.drawn())).toBeUndefined()
  const b1 = await assistant($, 'b1')
  expect(textOf(await b1.drawn())).toBe(ENGINE)
  expect(railOf(await b1.drawn())).toBeUndefined()
  const out = await toolResult($, 'toolu_1', { isExpanded: true })
  expect(textOf(await out.drawn())).toBe(ENGINE)
  // Back to the normal view: the duration line draws with the flag off, and the other rows follow.
  await d1.redraw({ word: 'Baked', durationMs: 41_000, isExpanded: false } as never)
  await u1.redraw({ text: 'x', origin: { kind: 'composer' }, isExpanded: false } as never)
  expect(await fullText(u1)).toBe(FOLDED_1)
  await b1.redraw()
  await out.redraw()
  expect(textOf(await b1.drawn())).toBe('')
  // The result row still carries its own flag (a click opened it), and hides with its folded turn all the same.
  expect(textOf(await out.drawn())).toBe('')
  await w.clock.advance(100)
  expect(w.logs).toContain('claudefolder: invalidate view')
  expect(w.logs).toContain('claudefolder: view expanded')
  expect(w.logs).toContain('claudefolder: view normal')
})

test('a row clicked open hides with its folded turn, and opens no other row', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  // The prompt row clicked open is turn 1's header: the card, never the engine's prompt.
  const u1 = await user($, 'u1', { isExpanded: true })
  expect(await fullText(u1)).toBe(FOLDED_1)
  for (const ui of [await toolUse($, 'toolu_1', { isExpanded: true }), await toolResult($, 'toolu_1', { isExpanded: true }), await assistant($, 'b1')]) {
    const drawn = await ui.drawn()
    expect(drawn).toMatchObject({ type: 'Box' })
    expect(textOf(drawn)).toBe('')
  }
  await w.clock.advance(100)
  expect(w.logs.filter(l => l.startsWith('claudefolder: invalidate view') || l.startsWith('claudefolder: view '))).toEqual([])
})

test('a row clicked open in an open turn keeps its bar, folds with the turn and comes back open', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  const out = await toolResult($, 'toolu_1', { isExpanded: true })
  expect(textOf(await out.drawn())).toBe(ENGINE)
  expect(textOf(railOf(await out.drawn()))).toBe(railText('▌'))
  expect((await folder($, 'close 1')).text).toBe('Folded turn #1.')
  await u1.redraw()
  await out.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
  expect(textOf(await out.drawn())).toBe('')
  await folder($, 'open 1')
  await out.redraw()
  expect(textOf(await out.drawn())).toBe(ENGINE)
  expect(textOf(railOf(await out.drawn()))).toBe(railText('▌'))
})

test('off the fullscreen terminal everything draws as the engine does', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const notFullscreen = await user($, 'u1', {}, { columns: 100, rows: 40, isFullscreen: false })
  expect(textOf(await notFullscreen.drawn())).toBe(ENGINE)
  await notFullscreen.unmount()
  const unmeasured = await user($, 'u1', {}, { columns: 100, rows: 40 })
  expect(textOf(await unmeasured.drawn())).toBe(ENGINE)
  await unmeasured.unmount()
  const desktop = await $.ui.mount({
    plugin: 'claudefolder',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text: 'x', origin: { kind: 'composer' }, isExpanded: false } as never,
    viewport: VIEWPORT,
  })
  expect(textOf(await desktop.drawn())).toBe(ENGINE)
})

test('under finish a turn folds 1.5 s after it ends', { options: { motion: 'off', foldWhen: 'finish' } }, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  const b1 = await assistant($, 'b1')
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  await w.clock.advance(1499)
  await u1.redraw()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  await w.clock.advance(1)
  await w.clock.settle()
  await u1.redraw()
  await b1.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
  expect(textOf(await b1.drawn())).toBe('')
})

test('one line puts the tools, files and time after the title on the first line', { options: { motion: 'off', lines: '1' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const text = await fullText(await user($, 'u1'))
  expect(text).toBe('▌ ▸ #1 · fix the login · 1 tool · edited auth.ts · 41s' + sp(44))
  expect(text.includes('└')).toBe(false)
  expect(text.length).toBe(98)
})

test('another marker setting changes the glyphs', { options: { motion: 'off', marker: 'ascii' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  expect((await fullText(u1)).startsWith('▌ > #1 · fix the login')).toBe(true)
  await click(u1, head(1), 2, 0)
  await u1.redraw()
  expect((await fullText(u1)).startsWith('▌ v #1')).toBe(true)
})

test('an interrupted turn says so in red, and has no reply to press', still, async ($, on) => {
  world(on)
  await runTurn($, 1, { reason: 'aborted', answer: '' })
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  // A failed turn keeps a red ✗ right after its number.
  expect(await fullText(u1)).toBe('▌ ▸ #1 ✗ · fix the login' + sp(74) + '▌   └ 1 tool · edited auth.ts · 41s · interrupted' + sp(49))
  const words = (await moduleRuns(u1, head(1))).filter(r => r.text === 'interrupted')
  expect(words.some(w => w.color === '#ff0000')).toBe(true)
  expect((await moduleRuns(u1, head(1))).some(r => r.text.includes('✗') && r.color === '#ff0000')).toBe(true)
  const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
  expect(props.press).toEqual([[0, 2, 4, 0]])
})

test('a group of calls the mod has not seen as a row folds through its call ids', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  const grp1 = await group($, 'grp1', ['toolu_1'])
  expect(textOf(await grp1.drawn())).toBe(ENGINE)
  await runTurn($, 2)
  await u1.redraw()
  await grp1.redraw()
  expect(textOf(await grp1.drawn())).toBe('')
  await user($, 'u2')
  expect(textOf(await (await group($, 'grp2', ['toolu_x', 'toolu_2'])).drawn())).toBe(ENGINE)
  expect(textOf(await (await group($, 'grp3', ['toolu_x'])).drawn())).toBe(ENGINE)
})

test('subagent rows and subagent turns never map to a turn', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await user($, 'u1')
  await $.turn.start({ text: 'look around', turnId: 's1', agentId: 'ag1' } as never)
  await append($, 'sa1', 'response', 'assistant', [{ type: 'text', text: 'found it' }], 'ag1')
  await $.turn.complete({ answer: 'found it', durationMs: 5000, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'ag1' } as never)
  await runTurn($, 2)
  expect(textOf(await (await assistant($, 'sa1')).drawn())).toBe(ENGINE)
  expect(textOf(await (await assistant($, 'b1')).drawn())).toBe('')
  // The subagent's turn took no number: the second main turn is #2.
  expect((await folder($, 'close last')).text).toBe('Folded turn #2.')
  expect(await fullText(await user($, 'u2'))).toContain('▸ #2 · ')
})

test('/folder toggles, opens and closes turns by number, last or all', still, async ($, on) => {
  world(on)
  expect((await folder($, '')).text).toBe('No finished turn yet.')
  await runTurn($, 1)
  await runTurn($, 2)
  // Turn 1 folded when turn 2 began, turn 2 is open: any folded means open all.
  expect((await folder($, '')).text).toBe('Opened 2 turns.')
  expect((await folder($, '')).text).toBe('Folded 2 turns.')
  expect((await folder($, 'open 1')).text).toBe('Opened turn #1.')
  expect(await fullText(await user($, 'u1'))).toBe(OPEN_1 + ENGINE)
  expect((await folder($, 'close last')).text).toBe('Folded turn #2.')
  expect((await fullText(await user($, 'u2'))).startsWith('▌ ▸ #2 · fix the login')).toBe(true)
  expect((await folder($, 'open')).text).toBe('Opened turn #2.')
  expect((await folder($, 'close all')).text).toBe('Folded 2 turns.')
  expect((await folder($, 'open all')).text).toBe('Opened 2 turns.')
  expect((await folder($, 'close 1')).text).toBe('Folded turn #1.')
  expect((await folder($, 'close 9')).text).toBe('No turn #9.')
})

test('/folder with bad arguments prints its usage, and a running turn is left alone', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const usage = 'Usage: /folder (toggle all) · /folder open [<n> | last | all] · /folder close [<n> | last | all] · /folder focus [off]'
  expect((await folder($, 'frob')).text).toBe(usage)
  expect((await folder($, 'open x')).text).toBe(usage)
  expect((await folder($, 'open 1 2')).text).toBe(usage)
  expect((await folder($, 'close -1')).text).toBe(usage)
  await $.turn.start({ text: 'again', turnId: 't2' } as never)
  expect((await folder($, 'close all')).text).toBe('Folded 1 turn.')
  expect((await folder($, 'close 2')).text).toBe('No turn #2.')
})

test('/folder explains itself on the main screen', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  expect((await folder($, '', false)).text).toBe(
    'Claude-Folder folds turns in the fullscreen view only. Turn it on with "tui": "fullscreen" in your settings, or CLAUDE_CODE_NO_FLICKER=1.',
  )
})

test('a /clear numbers the turns from 1 again', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  expect((await folder($, '')).text).toBe('No finished turn yet.')
  await runTurn($, 9)
  expect((await folder($, 'close last')).text).toBe('Folded turn #1.')
  expect((await folder($, 'open 2')).text).toBe('No turn #2.')
})

test('bare /folder open and close act on the newest folded and the newest open turn', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  await runTurn($, 3)
  // Turns 1 and 2 are folded, turn 3 is open.
  expect((await folder($, 'open')).text).toBe('Opened turn #2.')
  expect((await folder($, 'close')).text).toBe('Folded turn #3.')
  expect((await folder($, 'close')).text).toBe('Folded turn #2.')
  expect((await folder($, 'close')).text).toBe('No open turn to close.')
  expect((await folder($, 'open all')).text).toBe('Opened 3 turns.')
  expect((await folder($, 'open')).text).toBe('No folded turn to open.')
})

// ---- turns whose first row is not a typed prompt -------------------------------------------

test('a turn started by a hand-back folds onto the agent message row, titled by its sender', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  // The engine draws an agent's hand-back as a UserMessage of the door `prompt`: a meta row with the origin `peer`.
  await append($, 'm2', 'prompt', 'user', [{ type: 'text', text: 'agent output' }], undefined, undefined, true, 'peer')
  await $.turn.start({ text: '', turnId: 't2' } as never)
  await append($, 'a2', 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }])
  await append($, 'r2', 'tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }])
  await append($, 'b2', 'response', 'assistant', [{ type: 'text', text: 'Checks pass.' }])
  await $.turn.complete({ answer: 'Checks pass.', durationMs: 5000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await append($, 'd2', 'notice', 'system', [{ type: 'text', text: 'Baked for 5s' }], undefined, 'turn_duration')
  await runTurn($, 3)
  const m2 = await user($, 'm2', { text: 'agent output', origin: { kind: 'peer' }, from: { name: 'general-purpose' } })
  const b2 = await assistant($, 'b2')
  await w.clock.advance(1)
  const drawn = await fullText(m2)
  expect(drawn.startsWith('▌ ▸ #2 · Message from @general-purpose')).toBe(true)
  expect(drawn).toContain('└ Checks pass.')
  expect(railOf(await m2.drawn())).toBeUndefined()
  expect(textOf(await b2.drawn())).toBe('')
})

test('a turn with no starter folds onto its group row, and a result row is never the header', still, async ($, on) => {
  world(on)
  await $.turn.start({ text: '', turnId: 't9' } as never)
  await append($, 'a9', 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} }])
  await append($, 'r9', 'tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }])
  await append($, 'b9', 'response', 'assistant', [{ type: 'text', text: 'Done.' }])
  await $.turn.complete({ answer: 'Done.', durationMs: 3000, isAborted: false, turnId: 't9', reason: 'answer' } as never)
  await append($, 'd9', 'notice', 'system', [{ type: 'text', text: 'Baked for 3s' }], undefined, 'turn_duration')
  await runTurn($, 2)
  const grp9 = await group($, 'grp9', ['toolu_9'])
  const out = await toolResult($, 'toolu_9')
  const b9 = await assistant($, 'b9')
  expect((await fullText(grp9)).startsWith('▌ ▸ #1 · (continued)')).toBe(true)
  expect(textOf(await out.drawn())).toBe('')
  expect(textOf(await b9.drawn())).toBe('')
})

test('a tool-first turn whose first reply has text folds onto that reply row', still, async ($, on) => {
  world(on)
  await $.turn.start({ text: '', turnId: 't8' } as never)
  await append($, 'a8', 'response', 'assistant', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_8', name: 'Read', input: {} }])
  await append($, 'b8', 'response', 'assistant', [{ type: 'text', text: 'Done.' }])
  await $.turn.complete({ answer: 'Done.', durationMs: 3000, isAborted: false, turnId: 't8', reason: 'answer' } as never)
  await runTurn($, 2)
  const a8 = await assistant($, 'a8')
  const b8 = await assistant($, 'b8')
  expect((await fullText(a8)).startsWith('▌ ▸ #1 · (continued)')).toBe(true)
  expect(textOf(await b8.drawn())).toBe('')
})

// ---- the header Client -----------------------------------------------------------------------

test('the header is one Client keyed by the turn, and the plugin tree holds no Button and no hover', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  const drawn = await u1.drawn()
  const found = clients(drawn)
  expect(found.length).toBe(1)
  expect(keyOf(found[0]!)).toBe(head(1))
  expect(String(found[0]?.props?.module)).toMatch(/headerClient\.tsx$/)
  expect(found[0]?.props?.width).toBe(98)
  const props = found[0]?.props?.props as FolderHeadProps
  expect(props.turnId).toBe('t1')
  expect(props.press).toEqual([[0, 2, 4, 0]])
  expect(props.outline).toEqual([[0, 0], [1, 0]])
  expect(props.cyclic).toBe(false)
  expect(await fullText(u1)).toBe(FOLDED_1)
  expect(buttons(drawn)).toEqual([])
  expect(walk(drawn).filter(n => n.hover !== undefined)).toEqual([])
  expect(rasters(drawn)).toEqual([])
})

test('hovering tints the marker and the number only', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await hoverAt(u1, head(1), 5, 0)
  const tinted = await moduleRuns(u1, head(1))
  expect(coloredText(tinted, '#fff5d7')).toBe('▸ #1')
  expect(coloredText(tinted, '#d0d0d0')).toBe('')
  // The title is not part of the text that reacts, nor is the reply line.
  await hoverAt(u1, head(1), 20, 0)
  expect(coloredText(await moduleRuns(u1, head(1)), '#fff5d7')).toBe('')
  await hoverAt(u1, head(1), 7, 1)
  const reply = await moduleRuns(u1, head(1))
  expect(coloredText(reply, '#fff5d7')).toBe('')
  expect(coloredText(reply, '#d0d0d0')).toBe('')
  await hoverAt(u1, head(1), 5, 0)
  expect(coloredText(await moduleRuns(u1, head(1)), '#fff5d7')).toBe('▸ #1')
  await leave(u1, head(1))
  const rest = await moduleRuns(u1, head(1))
  expect(coloredText(rest, '#fff5d7')).toBe('')
  expect(coloredText(rest, '#d0d0d0')).toBe('')
})

test('a click on the marker or the number folds or opens the turn; a click elsewhere, or one that leaves them, does nothing', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await click(u1, head(1), 20, 0)
  await u1.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: head(1) })
  await u1.pointer({ type: 'up', x: 20, y: 0, button: 'left', in: head(1) })
  await click(u1, head(1), 0, 0)
  // The reply line is no target either.
  await click(u1, head(1), 7, 1)
  await u1.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
  await click(u1, head(1), 5, 0)
  await u1.redraw()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  // The module's own post toggles too; anything else it posts changes nothing.
  await u1.post({ type: 'toggle', turnId: 't1' }, { in: head(1) })
  await u1.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
  await u1.post({ type: 'x' }, { in: head(1) })
  await u1.post(null, { in: head(1) })
  await u1.post({ type: 'toggle', turnId: 7 }, { in: head(1) })
  await u1.redraw()
  expect(await fullText(u1)).toBe(FOLDED_1)
})

const boxed = { options: { style: 'boxed', shimmer: 'off' } } as const

test('Lively: one lap when the pointer enters the marker and number, none while it stays', boxed, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  const restTitle = await rowRuns(u1, head(1), 1)
  const restTop = await rowRuns(u1, head(1), 0)
  // From outside the target to inside it: an entry.
  await hoverAt(u1, head(1), 0, 0)
  await hoverAt(u1, head(1), 4, 0)
  // Moving inside it every frame for 5 s: the card lights for the one lap (40 frames) and never again.
  const seen = await lapStarts(u1, head(1), 100, () => hoverAt(u1, head(1), 4, 0))
  expect(seen).toEqual({ starts: 1, litFrames: 40 })
  // No background changes, and only the marker and the number under the pointer take the tint; the title is as at rest.
  expect((await moduleRuns(u1, head(1))).every(r => r.bg === undefined)).toBe(true)
  expect(coloredText(await moduleRuns(u1, head(1)), '#fff5d7')).toBe('▸ #1')
  expect(await rowRuns(u1, head(1), 1)).toEqual(restTitle)
  await leave(u1, head(1))
  expect(await rowRuns(u1, head(1), 0)).toEqual(restTop)
})

test('Lively: leaving and entering again starts one more lap, never a second one mid-lap', boxed, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await hoverAt(u1, head(1), 0, 0)
  await hoverAt(u1, head(1), 4, 0)
  // Leave and enter again mid-lap: the lap runs on and ends at its own frame.
  let frame = 0
  const mid = await lapStarts(u1, head(1), 60, async () => {
    frame += 1
    if (frame === 10) await leave(u1, head(1))
    if (frame === 11) await hoverAt(u1, head(1), 4, 0)
  })
  expect(mid).toEqual({ starts: 1, litFrames: 40 })
  // Leave and enter after it ended: one more lap.
  await leave(u1, head(1))
  await hoverAt(u1, head(1), 4, 0)
  expect(await lapStarts(u1, head(1), 60)).toEqual({ starts: 1, litFrames: 40 })
})

test('Subtle: hovering runs no lap, a click one lap at the subtle peak', { options: { motion: 'subtle', style: 'boxed', shimmer: 'off' } }, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  const restTitle = await rowRuns(u1, head(1), 1)
  await hoverAt(u1, head(1), 0, 0)
  await hoverAt(u1, head(1), 4, 0)
  expect(await lapStarts(u1, head(1), 10)).toEqual({ starts: 0, litFrames: 0 })
  expect(coloredText(await moduleRuns(u1, head(1)), '#fff5d7')).toBe('▸ #1')
  expect(await rowRuns(u1, head(1), 1)).toEqual(restTitle)
  await w.clock.advance(100)
  await click(u1, head(1), 4, 0)
  await u1.redraw()
  const seen = await lapStarts(u1, head(1), 60)
  expect(seen.starts).toBe(1)
  expect(seen.litFrames).toBeGreaterThan(0)
})

test('entering ▸ #1 from the title starts one lap', boxed, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  // The pointer is known to be on the title (outside the target), then moves onto the number.
  await hoverAt(u1, head(1), 5, 1)
  // The entry comes before the watch starts, so that the first frame watched is the lap's first.
  await hoverAt(u1, head(1), 5, 0)
  expect(await lapStarts(u1, head(1), 100, () => hoverAt(u1, head(1), 5, 0))).toEqual({ starts: 1, litFrames: 40 })
})

test('moving from ▸ #1 onto the title ends the hover without a new lap later', boxed, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await hoverAt(u1, head(1), 0, 0)
  await hoverAt(u1, head(1), 4, 0)
  // Let the entry lap end, then slide onto the title: the tint goes, and no lap starts as the pointer moves about on it.
  await u1.advance(3000)
  await hoverAt(u1, head(1), 8, 1)
  expect(coloredText(await moduleRuns(u1, head(1)), '#fff5d7')).toBe('')
  expect(await lapStarts(u1, head(1), 60, () => hoverAt(u1, head(1), 8, 1))).toEqual({ starts: 0, litFrames: 0 })
  expect(coloredText(await moduleRuns(u1, head(1)), '#fff5d7')).toBe('')
})

/** Points on a folded header (turn 1, 100 columns) that are not `▸ #1`: the title, the answer line, a card's sides and borders, a rule's dashes and time. */
const NOT_THE_TARGET = {
  rail: [[12, 0], [20, 0], [8, 1]],
  zebra: [[12, 0], [20, 0], [8, 1]],
  boxed: [[0, 1], [5, 1], [8, 2], [97, 2], [40, 0], [10, 3]],
  rules: [[5, 1], [8, 2], [40, 0], [9, 0]],
} as const

for (const style of ['rail', 'boxed', 'zebra', 'rules'] as const) {
  test(`${style}: a folded header's title, reply and card body neither click nor tint, and start no lap`, { options: { style, shimmer: 'off' } }, async ($, on) => {
    world(on)
    await runTurn($, 1)
    await runTurn($, 2)
    const u1 = await user($, 'u1')
    const folded = await fullText(u1)
    await hoverAt(u1, head(1), 0, 0)
    for (const [x, y] of NOT_THE_TARGET[style]) {
      expect(await lapStarts(u1, head(1), 10, () => hoverAt(u1, head(1), x, y))).toEqual({ starts: 0, litFrames: 0 })
      const runs = await moduleRuns(u1, head(1))
      expect(coloredText(runs, '#fff5d7')).toBe('')
      expect(coloredText(runs, '#d0d0d0')).toBe('')
      await click(u1, head(1), x, y)
      await u1.redraw()
      expect(await fullText(u1)).toBe(folded)
    }
    const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
    expect(props.press.length).toBe(1)
  })

  test(`${style}: the target is in the same cells folded and open, and the same spot folds the turn again`, { options: { motion: 'off', style } }, async ($, on) => {
    world(on)
    await runTurn($, 1)
    await runTurn($, 2)
    const u1 = await user($, 'u1')
    const pressOf = async () => (clients(await u1.drawn())[0]?.props?.props as FolderHeadProps).press
    const col = { rail: 2, zebra: 1, boxed: 3, rules: 4 }[style]
    const folded = await fullText(u1)
    expect(await pressOf()).toEqual([[0, col, 4, 0]])
    await click(u1, head(1), col, 0)
    await u1.redraw()
    expect(await pressOf()).toEqual([[0, col, 4, 0]])
    // The marker and the number read the same in both states but for the marker's glyph.
    expect((await moduleRows(u1, head(1)))[0]!.slice(col, col + 4)).toBe('▾ #1')
    await click(u1, head(1), col, 0)
    await u1.redraw()
    expect(await fullText(u1)).toBe(folded)
    expect((await moduleRows(u1, head(1)))[0]!.slice(col, col + 4)).toBe('▸ #1')
  })
}

test('the reply line is neither clickable nor tinted, and starts no lap', boxed, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await hoverAt(u1, head(1), 0, 0)
  expect(await lapStarts(u1, head(1), 10, () => hoverAt(u1, head(1), 8, 2))).toEqual({ starts: 0, litFrames: 0 })
  const runs = await moduleRuns(u1, head(1))
  expect(coloredText(runs, '#fff5d7')).toBe('')
  expect(coloredText(runs, '#d0d0d0')).toBe('')
  await click(u1, head(1), 8, 2)
  await u1.redraw()
  expect(await fullText(u1)).toBe(card(1, '▸', true))
})

test('a click folds with one lap and the marker flip, even with the pointer left on the header', boxed, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  // Open turn 1, let its effect end, and point at the open header: one hover lap, then nothing.
  await click(u1, head(1), 4, 0)
  await w.clock.advance(3000)
  await u1.redraw()
  await hoverAt(u1, head(1), 40, 0)
  await hoverAt(u1, head(1), 3, 0)
  await u1.advance(3000)
  // Fold it with the pointer resting on `▾ #1`.
  await click(u1, head(1), 3, 0)
  await w.clock.settle()
  await u1.redraw()
  const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
  expect(props.fx).toMatchObject({ kind: 'fold', age: 0 })
  // The marker shows the open glyph at the first frame (the flip's start), and `▸` from frame 2.
  expect((await moduleRows(u1, head(1)))[0]!.startsWith('╭─ ▾ #1')).toBe(true)
  await u1.advance(100)
  expect((await moduleRows(u1, head(1)))[0]!.startsWith('╭─ ▸ #1')).toBe(true)
  // One lap round the card, even with a move on the marker and the number every frame.
  const seen = await lapStarts(u1, head(1), 60, () => hoverAt(u1, head(1), 4, 0))
  expect(seen.starts).toBe(1)
  expect(seen.litFrames).toBeGreaterThan(0)
})

test('opening runs one lap along the open top line, and no text other than the marker changes', boxed, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  // The turn changed when the second prompt started: the click comes a moment later, so that it is a change the header sees.
  await w.clock.advance(100)
  await click(u1, head(1), 4, 0)
  await u1.redraw()
  const seen = await lapStarts(u1, head(1), 60, async () => {
    const top = (await moduleRows(u1, head(1)))[0]
    expect(top === cardTop(1) || top === cardTop(1).replace('▾', '▸')).toBe(true)
  })
  expect(seen.starts).toBe(1)
  expect(seen.litFrames).toBeGreaterThan(0)
})

test('the automatic fold plays one lap', boxed, async ($, on) => {
  const { u1 } = await foldedLively($, on)
  const seen = await lapStarts(u1, head(1), 60)
  expect(seen.starts).toBe(1)
  expect(seen.litFrames).toBe(40)
})

test('Off: the tint and the click work, and no light ever runs', { options: { motion: 'off', style: 'boxed' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await hoverAt(u1, head(1), 4, 0)
  expect(coloredText(await moduleRuns(u1, head(1)), '#fff5d7')).toBe('▸ #1')
  await click(u1, head(1), 4, 0)
  await u1.redraw()
  expect(await fullText(u1)).toBe(cardTop(1) + ENGINE)
  // No flip and no lap: the header carries no effect, and a frame later it is the same.
  expect((clients(await u1.drawn())[0]?.props?.props as FolderHeadProps).fx).toBeUndefined()
  await u1.advance(50)
  const first = await u1.drawn({ in: head(1) })
  await u1.advance(500)
  expect(await u1.drawn({ in: head(1) })).toEqual(first)
})

/**
 * What an open lights, per style: after the click (which opens the folded header) and one frame of the unfold effect, the
 * cells that differ from rest, but for the marker's own cell, which flips.
 */
async function litCells($: Engine, on: On, at: [number, number]): Promise<[number, number][]> {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  // The click comes a moment after the turn changed, so that the header sees a change.
  await w.clock.advance(100)
  await click(u1, head(1), at[0], at[1])
  await u1.redraw()
  const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
  await u1.advance(50)
  const lit = await cellStyles(u1, head(1))
  await u1.advance(3000)
  const marker = props.fx?.marker

  return differing(lit, await cellStyles(u1, head(1))).filter(([r, c]) => marker === undefined || r !== marker[0] || c !== marker[1])
}

test('Lively click, rail: the light is on the edge bar cells alone', { options: { shimmer: 'off' } }, async ($, on) => {
  const cells = await litCells($, on, [2, 0])
  expect(cells.length).toBeGreaterThan(0)
  expect(cells.every(([r, c]) => r === 0 && c === 0)).toBe(true)
})

test('Lively click, zebra: the light is on the caps alone', { options: { style: 'zebra', shimmer: 'off' } }, async ($, on) => {
  const cells = await litCells($, on, [1, 0])
  expect(cells.length).toBeGreaterThan(0)
  expect(cells.every(([r, c]) => r === 0 && (c === 0 || c === 97))).toBe(true)
})

test('Lively click, rules: the light is on the rule alone', { options: { style: 'rules', shimmer: 'off' } }, async ($, on) => {
  const cells = await litCells($, on, [4, 0])
  expect(cells.length).toBeGreaterThan(0)
  expect(cells.every(([r]) => r === 0)).toBe(true)
})

test('Lively click, boxed: the light is on the open top line outside the number', boxed, async ($, on) => {
  const cells = await litCells($, on, [4, 0])
  expect(cells.length).toBeGreaterThan(0)
  expect(cells.every(([r, c]) => r === 0 && (c < 5 || c > 6))).toBe(true)
})

test('there is no ripple: a folded header at rest never lights on its own', { options: { shimmer: 'off' } }, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  await runTurn($, 2)
  await u1.redraw()
  await w.clock.advance(3000)
  await u1.redraw()
  const rest = await u1.drawn({ in: head(1) })
  const written = w.writes.length
  await w.clock.advance(10_000)
  await u1.advance(10_000)
  expect(w.writes.length).toBe(written)
  expect(await u1.drawn({ in: head(1) })).toEqual(rest)
})

// ---- the fold effect, drawn by the header module itself ---------------------------------------

const GLINT = 0xfff5d7

/** The fold of turn 1 under Lively, as far as these tests look: two turns, the first folded and redrawn. */
async function foldedLively($: Engine, on: On) {
  const w = world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  await runTurn($, 2)
  await u1.redraw()

  return { w, u1 }
}

test('Lively (rail): the fold effect runs in the header module on its own clock, from a complete card, with no plugin write', { options: { shimmer: 'off' } }, async ($, on) => {
  const { w, u1 } = await foldedLively($, on)
  // The header carries the effect and its rest cells: the plugin draws it once.
  const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
  expect(props.fx).toMatchObject({ kind: 'fold', age: 0 })
  // The first frame is the whole folded card: the old marker flashes gold, the edge bars are at rest, no text is missing.
  const first = await moduleRows(u1, head(1))
  expect(first[0]).toBe('▌ ▾ #1 · fix the login' + sp(76))
  expect(first[1]).toBe('▌   └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(51))
  const firstRuns = await moduleRuns(u1, head(1))
  expect(firstRuns.some(t => t.text === '▾' && t.color === '#ffd700')).toBe(true)
  const edges = firstRuns.filter(t => t.text === '▌')
  expect(edges.length).toBe(2)
  expect(edges.every(t => t.color === '#00afaf')).toBe(true)

  // The frames run on the module's clock: the plugin writes nothing while 20 of them pass, and the marker flips then settles.
  const written = w.writes.length
  await u1.advance(50)
  expect((await moduleRows(u1, head(1)))[0]).toBe('▌ ▾ #1 · fix the login' + sp(76))
  await u1.advance(50)
  const flipped = await moduleRuns(u1, head(1))
  expect(flipped.some(t => t.text === '▸' && t.color === '#ffd700')).toBe(true)
  // The one lap of light is over the edge bar (the only outline of a rail header), and only there: no sweep, no glide over the text.
  expect(flipped.filter(t => t.text === '▌').some(t => t.color !== '#00afaf')).toBe(true)
  for (let i = 0; i < 8; i++) await u1.advance(50)
  // Frame 10: the flip and the lap are over; the header is at rest.
  const during = await moduleRuns(u1, head(1))
  expect(during.filter(t => t.text === '▸').every(t => t.color === '#00afaf')).toBe(true)
  for (let i = 0; i < 10; i++) await u1.advance(50)
  expect(w.writes.length).toBe(written)

  // Long after: everything at rest.
  await u1.advance(3000)
  const rest = await moduleRows(u1, head(1))
  expect(rest[0]).toBe('▌ ▸ #1 · fix the login' + sp(76))
  const restRuns = await moduleRuns(u1, head(1))
  expect(during).toEqual(restRuns)
  expect(restRuns.filter(t => t.text === '▸').every(t => t.color === '#00afaf')).toBe(true)
  expect(restRuns.filter(t => t.text === '▌').every(t => t.color === '#00afaf')).toBe(true)
  expect(w.writes.length).toBe(written)
})

test('a click fold draws the complete folded card in its first frame, and asks no invalidate', { options: { shimmer: 'off' } }, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  await click(u1, head(1), 2, 0)
  await w.clock.advance(3000)
  await u1.redraw()
  expect(await fullText(u1)).toBe(OPEN_1 + ENGINE)
  const redraws = (): number => w.logs.filter(l => l === 'claudefolder: invalidate toggle').length
  const before = redraws()
  // Fold it by a click: the header at once holds every cell of the folded card.
  await click(u1, head(1), 2, 0)
  await w.clock.settle()
  await u1.redraw()
  const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
  expect(props.fx).toMatchObject({ kind: 'fold', age: 0 })
  expect(await fullText(u1)).toBe('▌ ▾ #1 · fix the login' + sp(76) + '▌   └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(51))
  // A toggle asks no invalidate: the turn's write draws its rows again.
  expect(redraws()).toBe(before)
  await w.clock.advance(300)
  await w.clock.settle()
  expect(redraws()).toBe(before)
})

test('Subtle: a softer flash, and the plugin writes nothing while the effect runs', { options: { motion: 'subtle', shimmer: 'off' } }, async ($, on) => {
  const { w, u1 } = await foldedLively($, on)
  expect((await moduleRuns(u1, head(1))).some(t => t.text === '▾' && t.color === hex(mixColor(0x8a8a8a, GOLD, 0.5)))).toBe(true)
  const written = w.writes.length
  await u1.advance(1500)
  expect(w.writes.length).toBe(written)
})

test('Off: the header carries no effect, and nothing ticks', still, async ($, on) => {
  const { w, u1 } = await foldedLively($, on)
  expect(rasters(await u1.drawn())).toEqual([])
  const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
  expect(props.fx).toBeUndefined()
  const rest = await u1.drawn({ in: head(1) })
  expect((await moduleRows(u1, head(1)))[0]).toBe('▌ ▸ #1 · fix the login' + sp(76))
  const written = w.writes.length
  await w.clock.advance(2000)
  await u1.advance(2000)
  expect(w.writes.length).toBe(written)
  expect(await u1.drawn({ in: head(1) })).toEqual(rest)
})

// ---- the fallback: plain Text with Buttons over the text -------------------------------------

test('a header module that fails leaves every header as plain Text with Buttons over the text', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  expect(clients(await u1.drawn()).length).toBe(1)
  await fault(u1, 1)
  await u1.redraw()
  const drawn = await u1.drawn()
  expect(clients(drawn)).toEqual([])
  expect(textOf(drawn)).toBe(FOLDED_1)
  expect(buttons(drawn).map(keyOf)).toEqual(['fold-1'])
  expect(textOf(buttonOf(drawn, 'fold-1'))).toBe('▸ #1')
  expect(buttonOf(drawn, 'fold-1-reply')).toBeUndefined()
  expect(buttonOf(drawn, 'fold-1')?.props?.plain).toBe(true)
  expect(scoped(drawn)).toEqual(buttons(drawn))
  expect(scoped(drawn).every(n => (n.hover as { scope: string }).scope === 'claudefolder-1')).toBe(true)
  expect(buttonOf(drawn, 'fold-1')?.hover).toEqual({ scope: 'claudefolder-1', color: '#fff5d7' })
  expect(rasters(drawn)).toEqual([])
  await u1.press({ key: 'fold-1' })
  await u1.redraw()
  const open = await u1.drawn()
  expect(textOf(open)).toBe(OPEN_1 + ENGINE)
  expect(buttons(open).map(keyOf)).toEqual(['fold-1'])
  expect(textOf(buttonOf(open, 'fold-1'))).toBe('▾ #1')
  await u1.press({ key: 'fold-1' })
  await u1.redraw()
  expect(textOf(await u1.drawn())).toBe(FOLDED_1)
  await u1.press({ key: 'fold-1' })
  await u1.redraw()
  expect(textOf(await u1.drawn())).toBe(OPEN_1 + ENGINE)
})

test('in the fallback the bars carry no hover, and the only text in a Button is the marker and the number', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  const b1 = await assistant($, 'b1')
  await fault(u1, 1)
  await u1.redraw()
  await b1.redraw()
  expect(buttons(await b1.drawn())).toEqual([])
  expect(walk(await b1.drawn()).filter(n => n.hover !== undefined)).toEqual([])
  expect(scoped(await u1.drawn())).toEqual(buttons(await u1.drawn()))
  for (const n of buttons(await u1.drawn())) {
    expect(textOf(n)).toBe('▾ #1')
    for (const bad of ['▌', '·', '└']) expect(textOf(n).includes(bad)).toBe(false)
  }
})

test('in the fallback the header draws at rest: the motion lives in the module, so nothing shimmers', { options: { shimmer: 'off' } }, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  await fault(u1, 1)
  await runTurn($, 2)
  await u1.redraw()
  // The fold's first frame is the folded card whole, marker at rest.
  expect(textOf(buttonOf(await u1.drawn(), 'fold-1'))).toBe('▸ #1')
  expect(textOf(await u1.drawn())).toBe(FOLDED_1)
  const rest = runsOf(await u1.drawn())
  await w.clock.advance(50)
  await u1.redraw()
  expect(runsOf(await u1.drawn())).toEqual(rest)
  expect(rest.some(r => r.color === '#ffd700' || r.color === hex(mixColor(0x8a8a8a, GLINT, 0.6)))).toBe(false)
  expect(clients(await u1.drawn())).toEqual([])
})

// ---- the other styles ------------------------------------------------------------------------

/** A folded card of turn `n` at 100 columns, with or without its second line. */
const card = (n: number, mark: string, second: boolean): string =>
  '╭─ ' + mark + ' #' + n + ' ' + '─'.repeat(89) + '╮' +
  '│ fix the login' + sp(82) + '│' +
  (second ? '│ └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(52) + '│' : '') +
  '╰' + '─'.repeat(96) + '╯'

/** An open card's top border (the header line) of turn `n` (one digit): the marker and the number alone. */
const cardTop = (n: number): string => '╭─ ▾ #' + n + ' ' + '─'.repeat(89) + '╮'

const cardBottom = '╰' + '─'.repeat(96) + '╯'

test('boxed, folded: the card is drawn by the header module, and its press ranges are inside it', boxed, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  const drawn = await u1.drawn()
  expect(await fullText(u1)).toBe(card(1, '▸', true))
  expect(rasters(drawn)).toEqual([])
  expect(buttons(drawn)).toEqual([])
  const props = clients(drawn)[0]?.props?.props as FolderHeadProps
  expect(props.press).toEqual([[0, 3, 4, 0]])
  expect(props.cyclic).toBe(true)
  expect(props.outline.length).toBe(200)
  expect(railOf(drawn)).toBeUndefined()
  expect(gapOf(drawn)).toBeUndefined()
})

test('boxed, open: the turn sits inside its card, the top border is its header, the closer row adds the bottom', { options: { motion: 'off', style: 'boxed' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u2h = await user($, 'u2')
  const u2 = await u2h.drawn()
  expect(await fullText(u2h)).toBe(cardTop(2) + ENGINE)
  expect(buttons(u2)).toEqual([])
  expect((clients(u2)[0]?.props?.props as FolderHeadProps).press).toEqual([[0, 3, 4, 0]])
  expect(gapOf(u2)).toBeUndefined()
  // The engine part sits inside a Box two columns in from each side (a right margin of 2 and no `width`, which the engine
  // refuses above its own node), with the card's sides over it.
  const frame = walk(u2).find(
    n => n.props?.marginRight === 2 && n.props?.paddingLeft === 2 && n.props?.paddingRight === 2 && n.props?.width === undefined,
  )
  expect(frame).toBeDefined()
  expect(textOf(frame)).toBe(ENGINE)
  const sides = walk(frame).filter(n => n.props?.position === 'absolute')
  expect(sides.map(n => n.props?.left)).toEqual([0, 97])
  for (const side of sides) {
    const bar = walk(side).find(n => n.type === 'Text')
    expect(bar?.props?.color).toBe('#585858')
    expect(bar?.hover).toBeUndefined()
    expect(textOf(bar)).toBe(railText('│'))
  }
  // A row in the middle of the turn has the sides and no bottom; the duration line closes the card.
  const b2 = await (await assistant($, 'b2')).drawn()
  expect(textOf(b2)).toBe(ENGINE)
  expect(walk(b2).filter(n => n.props?.position === 'absolute').length).toBe(2)
  expect(walk(b2).filter(n => n.hover !== undefined)).toEqual([])
  expect(buttons(b2)).toEqual([])
  const d2 = await (await duration($, 'd2', 41_000)).drawn()
  expect(textOf(d2)).toBe(ENGINE + cardBottom)
  expect(buttons(d2)).toEqual([])
  expect(walk(d2).filter(n => n.hover !== undefined)).toEqual([])
})

test('boxed, a turn with no duration line closes under its last reply', { options: { motion: 'off', style: 'boxed' } }, async ($, on) => {
  world(on)
  await runTurn($, 1, { answer: 'Stopped.', noDuration: true })
  const u1 = await user($, 'u1')
  expect(textOf(await (await assistant($, 'b1')).drawn())).toBe(ENGINE + cardBottom)
  expect(await fullText(u1)).toBe(cardTop(1) + ENGINE)
})

test('zebra: folded turns alternate two tints with rounded ends, the open header is lavender, nothing has a bar or a gap', { options: { motion: 'off', style: 'zebra' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  await runTurn($, 3)
  const folded = (n: number): string =>
    '▐▸ #' + n + ' · fix the login' + sp(76) + '▌' + '▐  └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(51) + '▌'
  const bgs = async (ui: Awaited<ReturnType<typeof user>>, n: number, text = 'fix the login') =>
    (await moduleRuns(ui, head(n))).filter(r => r.text === text).map(r => r.bg)
  const u1 = await user($, 'u1')
  const u2 = await user($, 'u2')
  const u3 = await user($, 'u3')
  expect(await fullText(u1)).toBe(folded(1))
  expect(await bgs(u1, 1)).toContain('#1c3030')
  expect(await fullText(u2)).toBe(folded(2))
  expect(await bgs(u2, 2)).toContain('#262626')
  expect(await fullText(u3)).toBe('▐▾ #3' + sp(92) + '▌' + ENGINE)
  expect(await bgs(u3, 3, '#3')).toContain('#26243a')
  // The caps are glyphs in the band color on the terminal's background.
  const caps = (await moduleRuns(u1, head(1))).filter(r => r.text === '▐' || r.text === '▌')
  expect(caps.length).toBeGreaterThan(0)
  expect(caps.every(r => r.color === '#1c3030' && r.bg === undefined)).toBe(true)
  for (const ui of [u1, u2, u3, await assistant($, 'b3')]) {
    const drawn = await ui.drawn()
    expect(railOf(drawn)).toBeUndefined()
    expect(gapOf(drawn)).toBeUndefined()
  }
})

test('rules: a rule with the marker, the number and the time above header lines that fill the width', { options: { motion: 'off', style: 'rules' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const rule = (n: number): string => '─── ▸ #' + n + ' · 41s ' + '─'.repeat(83)
  const u1 = await user($, 'u1')
  expect(await fullText(u1)).toBe(rule(1) + '   fix the login' + sp(82) + '   └ Fixed it. · 1 tool · edited auth.ts' + sp(58))
  const u2 = await user($, 'u2')
  // An open turn's rule is one row: the marker and the number in it, and nothing else.
  expect(await fullText(u2)).toBe('─── ▾ #2 ' + '─'.repeat(89) + ENGINE)
  // The rule takes the boxed frame colors: teal folded, grey open.
  const ruleColor = async (ui: typeof u1, n: number) =>
    (await moduleRuns(ui, head(n))).filter(r => r.text.startsWith('─') && !r.text.includes('#')).map(r => r.color)
  expect((await ruleColor(u1, 1)).every(c => c === '#00afaf')).toBe(true)
  expect((await ruleColor(u2, 2)).every(c => c === '#585858')).toBe(true)
  expect((await ruleColor(u2, 2)).length).toBeGreaterThan(0)
  for (const ui of [u1, u2]) {
    const drawn = await ui.drawn()
    expect(railOf(drawn)).toBeUndefined()
    expect(gapOf(drawn)).toBeUndefined()
    expect(buttons(drawn)).toEqual([])
  }
})

test('the edge setting changes the bar on the header and on the rows', { options: { motion: 'off', edge: 'thin' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  expect((await fullText(u1)).startsWith('▎ ▾ ')).toBe(true)
  const b1 = await (await assistant($, 'b1')).drawn()
  expect(textOf(railOf(b1))).toBe(railText('▎'))
})

test('no Box above the engine node in any row the mod draws sets a prop the engine refuses', { options: { motion: 'off' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  expect(concealers(await (await user($, 'u1')).drawn())).toEqual([])
  expect(concealers(await (await assistant($, 'b1')).drawn())).toEqual([])
})

test('boxed: no Box above the engine node sets a prop the engine refuses', { options: { motion: 'off', style: 'boxed' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  expect(concealers(await (await user($, 'u2')).drawn())).toEqual([])
  expect(concealers(await (await assistant($, 'b2')).drawn())).toEqual([])
  expect(concealers(await (await duration($, 'd2', 41_000)).drawn())).toEqual([])
})

test('zebra: no Box above the engine node of an open header sets a prop the engine refuses', { options: { motion: 'off', style: 'zebra' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  expect(concealers(await (await user($, 'u2')).drawn())).toEqual([])
})

test('rules: no Box above the engine node of an open header sets a prop the engine refuses', { options: { motion: 'off', style: 'rules' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  expect(concealers(await (await user($, 'u2')).drawn())).toEqual([])
})

// ---- only the header text reacts, in every style ---------------------------------------------

for (const style of ['rail', 'boxed', 'zebra', 'rules'] as const) {
  test(`${style}: with the header module, no node the plugin draws has a Button or a hover, folded or open`, { options: { motion: 'off', style } }, async ($, on) => {
    world(on)
    await runTurn($, 1)
    await runTurn($, 2)
    const u1 = await user($, 'u1')
    const b1 = await assistant($, 'b1')
    const u2 = await user($, 'u2')
    const b2 = await assistant($, 'b2')
    const d2 = await duration($, 'd2', 41_000)
    for (const ui of [u1, b1, u2, b2, d2]) {
      const drawn = await ui.drawn()
      expect(buttons(drawn)).toEqual([])
      expect(walk(drawn).filter(n => n.hover !== undefined)).toEqual([])
    }
  })

  test(`${style}: in the fallback the only Buttons are fold-<n>, one per header over its marker and number, and the only hover scopes are theirs`, { options: { motion: 'off', style } }, async ($, on) => {
    world(on)
    await runTurn($, 1)
    await runTurn($, 2)
    const u1 = await user($, 'u1')
    const b1 = await assistant($, 'b1')
    const u2 = await user($, 'u2')
    const b2 = await assistant($, 'b2')
    const d2 = await duration($, 'd2', 41_000)
    await fault(u1, 1)
    for (const ui of [u1, b1, u2, b2, d2]) await ui.redraw()
    for (const ui of [u1, b1, u2, b2, d2]) {
      const drawn = await ui.drawn()
      expect(buttons(drawn).every(b => /^fold-\d+$/.test(keyOf(b)))).toBe(true)
      expect(scoped(drawn)).toEqual(buttons(drawn))
      expect(walk(drawn).filter(n => n.hover !== undefined && !buttons(drawn).includes(n))).toEqual([])
    }
    expect(buttons(await u1.drawn()).map(keyOf)).toEqual(['fold-1'])
    expect(textOf(buttonOf(await u1.drawn(), 'fold-1'))).toBe('▸ #1')
    // No Button holds the title, the reply or the stats: only the Text runs of `▸ #1`.
    for (const b of buttons(await u1.drawn())) {
      for (const bad of ['fix the login', 'Fixed it', 'tool', '41s']) expect(textOf(b).includes(bad)).toBe(false)
      expect(runsOf(b).map(r => r.text).join('')).toBe('▸ #1')
    }
    expect(buttons(await u2.drawn()).map(keyOf)).toEqual(['fold-2'])
    expect(textOf(buttonOf(await u2.drawn(), 'fold-2'))).toBe('▾ #2')
  })
}

// ---- v6b: a turn filed in the order the engine draws it ---------------------------------------

const boxedStill = { options: { motion: 'off', style: 'boxed' } } as const

/** The open card's top line of turn 1 at 100 columns: `╭─ ▾ #1 ` (8 cells), 89 dashes and the corner. */
const TEST_TOP = '╭─ ▾ #1 ' + '─'.repeat(89) + '╮'

const ATTACHMENTS = ['environment', 'deferred_tools_delta', 'mcp_instructions_delta', 'total_tokens_reminder', 'deferred_tools_record']

/** The attachment rows the engine appends right after a prompt. */
async function attach($: Engine) {
  for (let i = 0; i < ATTACHMENTS.length; i++) await append($, 'att' + i, 'attachment', 'attachment', [], undefined, ATTACHMENTS[i])
}

const answerOf = (turnId: string) => ({ answer: 'Hello', durationMs: 4000, isAborted: false, turnId, reason: 'answer' }) as never

test('the live sequence in draw order: the prompt and the reply are inside the card, and the duration line closes it', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'u', 'prompt', 'user', [{ type: 'text', text: 'test' }])
  const u = await user($, 'u')
  expect(textOf(await u.drawn())).toBe(ENGINE)
  await $.turn.start({ text: 'test', turnId: 't1' } as never)
  await attach($)
  await append($, 'b', 'response', 'assistant', [{ type: 'text', text: 'Hello' }])
  const b = await assistant($, 'b', { text: 'Hello' })
  expect(textOf(await b.drawn())).toBe(ENGINE)
  expect(walk(await b.drawn()).filter(n => n.props?.position === 'absolute')).toEqual([])
  await $.turn.complete(answerOf('t1'))
  await append($, 'd', 'notice', 'system', [{ type: 'text', text: 'Churned for 4s' }], undefined, 'turn_duration')
  const d = await duration($, 'd', 4000)
  await w.clock.advance(1)
  for (const ui of [u, b, d]) await ui.redraw()
  expect(await fullText(u)).toBe(TEST_TOP + ENGINE)
  const framedB = await b.drawn()
  expect(textOf(framedB)).toBe(ENGINE)
  expect(walk(framedB).filter(n => n.props?.position === 'absolute').length).toBe(2)
  expect(clients(framedB)).toEqual([])
  const framedD = await d.drawn()
  expect(textOf(framedD)).toBe(ENGINE + cardBottom)
  expect(walk(framedD).filter(n => n.props?.position === 'absolute').length).toBe(2)
  expect(clients(framedD)).toEqual([])
})

test('race: the turn starts before the prompt row is appended, and everything still lands inside the card', boxedStill, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'test', turnId: 't1' } as never)
  await append($, 'u', 'prompt', 'user', [{ type: 'text', text: 'test' }])
  const u = await user($, 'u')
  await attach($)
  await append($, 'b', 'response', 'assistant', [{ type: 'text', text: 'Hello' }])
  const b = await assistant($, 'b', { text: 'Hello' })
  await $.turn.complete(answerOf('t1'))
  await append($, 'd', 'notice', 'system', [{ type: 'text', text: 'Churned for 4s' }], undefined, 'turn_duration')
  const d = await duration($, 'd', 4000)
  await w.clock.advance(1)
  for (const ui of [u, b, d]) await ui.redraw()
  expect(await fullText(u)).toBe(TEST_TOP + ENGINE)
  expect(textOf(await b.drawn())).toBe(ENGINE)
  expect(walk(await b.drawn()).filter(n => n.props?.position === 'absolute').length).toBe(2)
  expect(textOf(await d.drawn())).toBe(ENGINE + cardBottom)
  expect(clients(await b.drawn())).toEqual([])
  expect(clients(await d.drawn())).toEqual([])
})

test("a meta row between the prompt and the turn does not take the prompt's place: the header stays on the prompt", boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'u', 'prompt', 'user', [{ type: 'text', text: 'test' }])
  const u = await user($, 'u')
  await append($, 'm', 'prompt', 'user', [{ type: 'text', text: 'reminder' }], undefined, undefined, true)
  const m = await user($, 'm', { text: 'reminder' })
  await $.turn.start({ text: 'test', turnId: 't1' } as never)
  await append($, 'b', 'response', 'assistant', [{ type: 'text', text: 'Hello' }])
  await $.turn.complete(answerOf('t1'))
  await append($, 'd', 'notice', 'system', [{ type: 'text', text: 'Churned for 4s' }], undefined, 'turn_duration')
  await w.clock.advance(1)
  for (const ui of [u, m]) await ui.redraw()
  expect(await fullText(u)).toBe(TEST_TOP + ENGINE)
  const framedM = await m.drawn()
  expect(textOf(framedM)).toBe(ENGINE)
  expect(walk(framedM).filter(n => n.props?.position === 'absolute').length).toBe(2)
  expect(clients(framedM)).toEqual([])
})

// ---- background agents: duration lines the engine leaves out, and notification titles ------------

/** The text a task notification row of agent `agent` holds. */
const notificationOf = (agent: string, summary: string): string =>
  '<task-notification>\n<task-id>' + agent + '</task-id>\n<status>completed</status>\n<summary>' + summary + '</summary>\n</task-notification>'

test('boxed: a hand-back turn whose duration line the engine leaves out closes its card under its reply', boxedStill, async ($, on) => {
  const w = world(on)
  await runAgentTurn($, 1)
  await append($, 'h2', 'prompt', 'user', [{ type: 'text', text: 'Another Claude session sent a message' }], undefined, undefined, true, 'peer')
  await $.turn.start({ text: '', turnId: 't2' } as never)
  await append($, 'b2', 'response', 'assistant', [{ type: 'text', text: 'Done.' }])
  await $.turn.complete({ answer: 'Done.', durationMs: 3000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await append($, 'd2', 'notice', 'system', [{ type: 'text', text: 'Baked for 3s' }], undefined, 'turn_duration')
  await append($, 'n3', 'prompt', 'user', [{ type: 'text', text: notificationOf('agent-toolu_bg1', 'Agent "x" finished') }], undefined, undefined, false, 'task-notification')
  const h2 = await user($, 'h2', { from: { name: 'general-purpose' } })
  const b2 = await assistant($, 'b2')
  const d2 = await duration($, 'd2', 3_000)
  const n3 = await user($, 'n3', { origin: { kind: 'task-notification' }, task: { id: 'agent-toolu_bg1', status: 'completed' } })
  await w.clock.advance(1)
  for (const ui of [h2, b2, d2, n3]) await ui.redraw()
  expect((await fullText(h2)).startsWith('╭─ ▾ #2')).toBe(true)
  const closed = await b2.drawn()
  expect(textOf(closed)).toBe(ENGINE + cardBottom)
  expect(walk(closed).filter(n => n.props?.position === 'absolute').length).toBe(2)
  const plainD = await d2.drawn()
  expect(textOf(plainD)).toBe(ENGINE)
  expect(walk(plainD).filter(n => n.props?.position === 'absolute').length).toBe(0)
  const plainN = await n3.drawn()
  expect(textOf(plainN)).toBe(ENGINE)
  expect(walk(plainN).filter(n => n.props?.position === 'absolute').length).toBe(0)
  expect(w.logs).toContain('claudefolder: turn.complete 2 header=h2 closer=b2 status=done')
})

test('a turn started by a task notification is titled by its summary, never by the tag', still, async ($, on) => {
  const w = world(on)
  const body = notificationOf('agent-toolu_bg1', 'Agent "Quick test agent" finished')
  await runAgentTurn($, 1)
  await append($, 'n2', 'prompt', 'user', [{ type: 'text', text: body }], undefined, undefined, false, 'task-notification')
  await $.turn.start({ text: body, turnId: 't2' } as never)
  await append($, 'b2', 'response', 'assistant', [{ type: 'text', text: 'Noted.' }])
  await $.turn.complete({ answer: 'Noted.', durationMs: 2000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await append($, 'd2', 'notice', 'system', [{ type: 'text', text: 'Baked for 2s' }], undefined, 'turn_duration')
  const saved = w.writes.filter(x => x.key === 'turn' && (x.value as { turnId?: string }).turnId === 't2')
  expect((saved[saved.length - 1]?.value as { title?: string }).title).toBe('Agent "Quick test agent" finished')
  await runTurn($, 3)
  const n2 = await user($, 'n2', {
    text: 'Agent "Quick test agent" finished',
    origin: { kind: 'task-notification' },
    task: { id: 'agent-toolu_bg1' },
  })
  await w.clock.advance(1)
  const drawn = await fullText(n2)
  expect(drawn).toContain('Agent "Quick test agent" finished')
  expect(drawn.includes('<task-notification>')).toBe(false)
})

test('boxed: a typed prompt after a notification that started no turn: the notification joins the turn before and closes its card', boxedStill, async ($, on) => {
  const w = world(on)
  await runAgentTurn($, 1)
  await append($, 'n2', 'prompt', 'user', [{ type: 'text', text: notificationOf('agent-toolu_bg1', 'Agent "x" finished') }], undefined, undefined, false, 'task-notification')
  await append($, 'u2', 'prompt', 'user', [{ type: 'text', text: 'and now?' }])
  await $.turn.start({ text: 'and now?', turnId: 't2' } as never)
  await append($, 'b2', 'response', 'assistant', [{ type: 'text', text: 'Fine.' }])
  await $.turn.complete({ answer: 'Fine.', durationMs: 41_000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await append($, 'd2', 'notice', 'system', [{ type: 'text', text: 'Baked for 41s' }], undefined, 'turn_duration')
  const u2 = await user($, 'u2')
  const n2 = await user($, 'n2', { task: { id: 'agent-toolu_bg1' } })
  const d2 = await duration($, 'd2', 41_000)
  await w.clock.advance(1)
  for (const ui of [u2, n2, d2]) await ui.redraw()
  expect((await fullText(u2)).startsWith('╭─ ▾ #2')).toBe(true)
  // Turn 1 folded at turn.start t2, and its header u1 is never mounted: its rows draw open-unseen, the notification closing the card.
  const closedN = await n2.drawn()
  expect(textOf(closedN)).toBe(ENGINE + cardBottom)
  expect(walk(closedN).filter(n => n.props?.position === 'absolute').length).toBe(2)
  expect(textOf(await d2.drawn())).toBe(ENGINE + cardBottom)
  expect(w.logs).toContain('claudefolder: append prompt user composer u2 -> pending typed, moved 1 to tail 1')
})

// ---- rows after the duration line are not part of the turn -------------------------------------

/** A notice or a log line the engine draws as command output. */
const logLine = ($: Engine, requestId: string) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId,
    props: { text: 'claudefolder: options changed' } as never,
    viewport: VIEWPORT,
  })

for (const [name, options, marks] of [
  ['rail', still, 1],
  ['boxed', boxedStill, 2],
] as const) {
  const edges = (node: unknown): number => walk(node).filter(n => n.props?.position === 'absolute').length

  test(`${name}: a row appended after the duration line draws as the engine does, and a folded turn does not hide it`, options, async ($, on) => {
    const w = world(on)
    // The turn ends with no duration line yet: an interrupt notice that follows is still inside the turn.
    await runTurn($, 1, { noDuration: true })
    await append($, 'int', 'notice', 'system', [{ type: 'text', text: 'Interrupted' }])
    await append($, 'd1', 'notice', 'system', [{ type: 'text', text: 'Baked for 41s' }], undefined, 'turn_duration')
    // Idle rows after the duration line: a log line of the mod itself, and a notice.
    await append($, 'log', 'notice', 'system', [{ type: 'text', text: 'claudefolder: options changed' }])
    await append($, 'note', 'notice', 'system', [{ type: 'text', text: 'a later notice' }])
    const u1 = await user($, 'u1')
    const b1 = await assistant($, 'b1')
    const int = await logLine($, 'int')
    const d1 = await duration($, 'd1', 41_000)
    const log = await logLine($, 'log')
    const note = await logLine($, 'note')
    await w.clock.advance(1)
    for (const ui of [u1, b1, int, d1, log, note]) await ui.redraw()
    expect(w.logs).toContain('claudefolder: append notice system composer int -> tail 1')
    expect(w.logs).toContain('claudefolder: append notice system composer log -> unassigned')
    expect(w.logs).toContain('claudefolder: append notice system composer note -> unassigned')
    // Inside the turn: the reply, the interrupt notice and the duration line carry its bar or sides; the duration closes a card.
    for (const ui of [b1, int, d1]) expect(edges(await ui.drawn())).toBe(marks)
    expect(textOf(await int.drawn())).toBe(ENGINE)
    expect(textOf(await d1.drawn())).toBe(name === 'boxed' ? ENGINE + cardBottom : ENGINE)
    // After it: no bar, no sides, no bottom border.
    for (const ui of [log, note]) {
      expect(textOf(await ui.drawn())).toBe(ENGINE)
      expect(edges(await ui.drawn())).toBe(0)
    }
    // Folded, the turn hides its own rows and leaves these two as the engine draws them.
    expect((await folder($, 'close 1')).text).toBe('Folded turn #1.')
    await w.clock.advance(1)
    for (const ui of [b1, int, d1, log, note]) await ui.redraw()
    for (const ui of [b1, int, d1]) {
      expect(textOf(await ui.drawn())).toBe('')
      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    }
    for (const ui of [log, note]) {
      expect(textOf(await ui.drawn())).toBe(ENGINE)
      expect(edges(await ui.drawn())).toBe(0)
    }
  })
}

// ---- the open card's sides and bottom, and the rail bar: plain Text ----------------------------

test("boxed, lively: an open card's sides and bottom are plain Text with no hover, and the only Client is the header", boxed, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1h = await user($, 'u1')
  const b1h = await assistant($, 'b1')
  const d1h = await duration($, 'd1', 41_000)
  const u1 = await u1h.drawn()
  const b1 = await b1h.drawn()
  const d1 = await d1h.drawn()
  expect(clients(u1).map(keyOf)).toEqual([head(1)])
  expect(clients(b1)).toEqual([])
  expect(clients(d1)).toEqual([])
  const sides = walk(b1).filter(n => n.props?.position === 'absolute')
  expect(sides.map(n => n.props?.left)).toEqual([0, 97])
  for (const side of sides) {
    const bar = walk(side).find(n => n.type === 'Text')
    expect(textOf(bar)).toBe(railText('│'))
    expect(bar?.props?.color).toBe('#585858')
  }
  expect(textOf(d1)).toBe(ENGINE + cardBottom)
  expect(scoped(b1)).toEqual([])
  expect(scoped(d1)).toEqual([])
  for (const drawn of [u1, b1, d1]) expect(concealers(drawn)).toEqual([])
})

test('rail, lively: the open turn bar is plain Text down every row', { options: { shimmer: 'off' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const b1 = await (await assistant($, 'b1')).drawn()
  expect(clients(b1)).toEqual([])
  const bar = railOf(b1)
  expect(textOf(bar)).toBe(railText('▌'))
  expect(bar?.props?.color).toBe('#00afaf')
  expect(scoped(b1)).toEqual([])
})

test("boxed, lively: hovering an open header's ▾ #1 runs the header's own light along the top line and writes no state", boxed, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1')
  const rest = await rowRuns(u1, head(1), 0)
  const written = w.writes.length
  // From outside the text to inside it: an entry.
  await hoverAt(u1, head(1), 40, 0)
  await hoverAt(u1, head(1), 3, 0)
  // The light enters off the left end of the top line (its head starts three cells before the corner), so from the first
  // frame the corner cell takes a mix of its border color and the glint, and the border run no longer has the rest color.
  let seen = false
  for (let f = 1; f <= 4; f++) {
    await u1.advance(50)
    const first = (await rowRuns(u1, head(1), 0))[0]
    if (first !== undefined && first.text.startsWith('╭') && first.color !== rest[0]?.color) seen = true
  }
  expect(seen).toBe(true)
  expect(w.writes.length).toBe(written)
  // The lap ends by itself with the pointer still on the text, and no other one starts.
  await u1.advance(2000)
  expect(await lapStarts(u1, head(1), 60, () => hoverAt(u1, head(1), 3, 0))).toEqual({ starts: 0, litFrames: 0 })
  await leave(u1, head(1))
  expect(await rowRuns(u1, head(1), 0)).toEqual(rest)
  expect(w.writes.length).toBe(written)
})

// ---- the bars start at the row's first line on screen ---------------------------------------------

/** The absolutely placed boxes of a drawn tree: an open card's two sides, or the rail's one bar. */
const barsOf = (node: unknown): Node[] => walk(node).filter(n => n.props?.position === 'absolute')

/** What the engine reports of a row: `first` of its `of` rows scrolled away above the viewport. */
const seen = (first: number, of: number) => ({ onScreen: { first, last: of - 1, of } })

test('boxed: a row partly scrolled above the viewport starts its sides at its first line on screen', boxedStill, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  // The duration line moves the closer with a write the notice starts and nobody awaits: let it land before the first draw.
  await w.clock.advance(1)
  await w.clock.settle()
  const b1 = await assistant($, 'b1', seen(3, 10))
  const drawn = await b1.drawn()
  expect(barsOf(drawn).map(n => n.props?.left)).toEqual([0, 97])
  expect(barsOf(drawn).map(n => n.props?.top)).toEqual([3, 3])
  expect(barsOf(drawn).map(n => n.props?.bottom)).toEqual([0, 0])
  expect(textOf(drawn)).toBe(ENGINE)
  expect(concealers(drawn)).toEqual([])
  // Not reported yet (the first draw): from the top.
  await b1.redraw({ text: 'Fixed it.', isFirstOfReply: true } as never)
  expect(barsOf(await b1.drawn()).map(n => n.props?.top)).toEqual([0, 0])
  // Drawn outside the viewport: no bar, and the row keeps its place inside the card.
  await b1.redraw({ text: 'Fixed it.', isFirstOfReply: true, onScreen: null } as never)
  const outside = await b1.drawn()
  expect(barsOf(outside)).toEqual([])
  expect(textOf(outside)).toBe(ENGINE)
  const frame = walk(outside).find(n => n.props?.marginRight === 2 && n.props?.paddingLeft === 2 && n.props?.paddingRight === 2)
  expect(frame).toBeDefined()
})

test('boxed: the duration line starts its sides at its first line on screen, and draws none when only the bottom border is on screen', boxedStill, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  // The duration line moves the closer with a write the notice starts and nobody awaits: let it land before the first draw.
  await w.clock.advance(1)
  await w.clock.settle()
  const d1 = await duration($, 'd1', 41_000, seen(2, 4))
  const drawn = await d1.drawn()
  expect(barsOf(drawn).map(n => n.props?.top)).toEqual([2, 2])
  expect(textOf(drawn)).toBe(ENGINE + cardBottom)
  await d1.redraw({ word: 'Baked', durationMs: 41_000, ...seen(3, 4) } as never)
  const border = await d1.drawn()
  expect(barsOf(border)).toEqual([])
  expect(textOf(border)).toBe(ENGINE + cardBottom)
})

test('boxed: the open header row starts the sides of its engine part below its top line', boxedStill, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const u1 = await user($, 'u1', seen(0, 12))
  expect(barsOf(await u1.drawn()).map(n => n.props?.top)).toEqual([0, 0])
  expect(await fullText(u1)).toBe(TEST_TOP + ENGINE)
  await u1.redraw({ text: 'x', origin: { kind: 'composer' }, isExpanded: false, ...seen(4, 12) } as never)
  expect(barsOf(await u1.drawn()).map(n => n.props?.top)).toEqual([3, 3])
})

test('rail: a row and the open header row start the bar at their first line on screen', still, async ($, on) => {
  world(on)
  await runTurn($, 1)
  const drawn = await (await assistant($, 'b1', seen(2, 6))).drawn()
  expect(barsOf(drawn).length).toBe(1)
  expect(barsOf(drawn)[0]?.props?.top).toBe(2)
  expect(textOf(railOf(drawn))).toBe(railText('▌'))
  const u1 = await user($, 'u1', seen(5, 20))
  const header = await u1.drawn()
  expect(barsOf(header).length).toBe(1)
  expect(barsOf(header)[0]?.props?.top).toBe(3)
  expect(gapOf(header)).toBeDefined()
  await u1.redraw({ text: 'x', origin: { kind: 'composer' }, isExpanded: false, ...seen(1, 20) } as never)
  expect(barsOf(await u1.drawn())[0]?.props?.top).toBe(0)
})

test('boxed: a scroll that moves a row past the top redraws its sides only: no state write and no invalidate', boxedStill, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  const b1 = await assistant($, 'b1', seen(0, 10))
  await w.clock.advance(2000)
  await w.clock.settle()
  const writes = w.writes.length
  const logs = w.logs.length
  await b1.redraw({ text: 'Fixed it.', isFirstOfReply: true, ...seen(6, 10) } as never)
  expect(barsOf(await b1.drawn()).map(n => n.props?.top)).toEqual([6, 6])
  expect(w.writes.length).toBe(writes)
  expect(w.logs.slice(logs).some(l => l.startsWith('claudefolder: invalidate'))).toBe(false)
})

// ---- three folded lines ----------------------------------------------------------------------

test('the lines setting takes 1, 2 or 3 and falls back to 2', () => {
  expect(normalizeSettings({ lines: '3' }).lines).toBe(3)
  expect(normalizeSettings({ lines: '1' }).lines).toBe(1)
  expect(normalizeSettings({ lines: '2' }).lines).toBe(2)
  expect(normalizeSettings({ lines: 'x' }).lines).toBe(2)
  expect(normalizeSettings({}).lines).toBe(2)
})

test('three lines fold turn 1 into the five-row card, read through the header Client', { options: { motion: 'off', style: 'boxed', lines: '3' } }, async ($, on) => {
  world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  const u1 = await user($, 'u1')
  const row = (s: string): string => s + sp(97 - Array.from(s).length) + '│'
  expect(await moduleRows(u1, head(1))).toEqual([
    '╭─ ▸ #1 ' + '─'.repeat(89) + '╮',
    row('│ fix the login'),
    row('│ ├ Fixed it.'),
    row('│ └ 1 tool · edited auth.ts · 41s'),
    '╰' + '─'.repeat(96) + '╯',
  ])
  const props = clients(await u1.drawn())[0]?.props?.props as FolderHeadProps
  expect(props.press).toEqual([[0, 3, 4, 0]])
  expect(props.cyclic).toBe(true)
  expect(props.outline.length).toBe(2 * 98 + 2 * 3)
})
