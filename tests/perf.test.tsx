import type { On } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { PALETTES, packCells } from '../hooks/cells'
import type { HeadCell } from '../hooks/cells'
import { buildHeader } from '../hooks/header'
import { cellsOf } from '../hooks/headerClient'
import { composeRows, composeText, createMotion, lineCells } from '../hooks/motion'

// How much the mod asks of the engine: invalidates, row dispatches, state reads and writes, in the real order of events and
// with no `redraw()` before an assertion. A row follows its turn through the turn member it reads while drawing: a write to a
// turn draws that turn's rows again, and no other row. The only invalidates are the load's, the fault's and the collapse one.

const ENGINE = 'ENGINE'

const VIEWPORT = { columns: 100, rows: 40, isFullscreen: true } as const

const ROWS = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'TurnDuration', 'CommandOutput'] as const

/** Loads above the mod and logs every row dispatch the engine makes (`dispatch <requestId>`), whoever answers it. */
const counter: Plugin = {
  name: 'counter',
  tier: 'prepend',
  register(on) {
    on('ui.render', { component: ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'TurnDuration', 'CommandOutput'] }, ($, e, next) => {
      $.ui.log('dispatch ' + e.requestId, { to: 'debug' })
      return next(e)
    })
  },
}

type Read = { key: string; id: string }

/** The engine beneath the mod, with every invalidate, state read and state write the mod makes counted. */
function world(on: On) {
  const logs: string[] = []
  /** One entry per `$.ui.invalidate` call the mod made, in order. */
  const invalidates: string[] = []
  const reads: Read[] = []
  const writes: Read[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.log', (_$, e, next) => {
    logs.push(e.text)
    return next(e)
  })
  on('ui.invalidate', (_$, e, next) => {
    invalidates.push(String(e.event))
    return next(e)
  })
  on('state.get', (_$, e, next) => {
    const ref = e as unknown as { plugin?: string; key?: string; id?: string }
    if (ref.plugin === 'claudefolder') reads.push({ key: String(ref.key), id: String(ref.id ?? '') })
    return next(e)
  })
  on('state.set', (_$, e, next) => {
    const ref = e as unknown as { plugin?: string; key?: string; id?: string }
    if (ref.plugin === 'claudefolder') writes.push({ key: String(ref.key), id: String(ref.id ?? '') })
    return next(e)
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.render', ({ ui }, e) => {
    const { Text } = ui.resolve(e)
    return <Text>{ENGINE}</Text>
  })

  /** The dispatches of each requestId logged since `mark` (a length of `logs`). */
  const dispatchesSince = (mark: number): Map<string, number> => {
    const out = new Map<string, number>()
    for (const l of logs.slice(mark)) if (l.startsWith('dispatch ')) out.set(l.slice(9), (out.get(l.slice(9)) ?? 0) + 1)
    return out
  }
  /** The invalidate reasons the mod logged since `mark`. */
  const reasonsSince = (mark: number): string[] => logs.slice(mark).filter(l => l.startsWith('claudefolder: invalidate ')).map(l => l.slice(25))

  return { logs, invalidates, reads, writes, clock, dispatchesSince, reasonsSince }
}

type World = ReturnType<typeof world>

const append = ($: Engine, uuid: string, door: string, type: string, content: unknown[], name?: string, isMeta = false) =>
  $.session.append({
    message: { type, content, ...(name === undefined ? {} : { name }), ...(isMeta ? { isMeta: true } : {}) },
    door,
    origin: door === 'response' ? { kind: 'model', model: 'claude-opus-5-5' } : { kind: 'composer' },
    uuid,
  } as never)

const say = (t: string) => [{ type: 'text', text: t }]

const mount = ($: Engine, component: (typeof ROWS)[number], requestId: string, props: Record<string, unknown>) =>
  $.ui.mount({ plugin: 'claudefolder', surface: 'terminal', component, requestId, props: props as never, viewport: VIEWPORT })

const user = ($: Engine, id: string) => mount($, 'UserMessage', id, { text: 'test', origin: { kind: 'composer' }, isExpanded: false })
const assistant = ($: Engine, id: string) => mount($, 'AssistantMessage', id, { text: 'Hello', isFirstOfReply: true })
const duration = ($: Engine, id: string) => mount($, 'TurnDuration', id, { word: 'Churned', durationMs: 4000 })
const toolUse = ($: Engine, id: string) =>
  mount($, 'ToolUse', id, { tool_use_id: id, tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false })

const answerOf = (turnId: string) => ({ answer: 'Hello', durationMs: 4000, isAborted: false, turnId, reason: 'answer' }) as never

/** `/folder <args>`, as the composer runs it. */
const folder = ($: Engine, args: string) =>
  $.command.run({ command: 'folder', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as never) as Promise<{ text: string }>

/** One turn `n` in the engine order, its prompt, reply and duration line mounted while it runs or as they come; no redraw. */
async function liveTurn($: Engine, w: World, n: number) {
  const turnId = 't' + n
  await append($, 'u' + n, 'prompt', 'user', say('test'))
  const u = await user($, 'u' + n)
  await $.turn.start({ text: 'test', turnId } as never)
  await append($, 'b' + n, 'response', 'assistant', say('Hello'))
  const b = await assistant($, 'b' + n)
  await Promise.all([$.turn.complete(answerOf(turnId)), append($, 'd' + n, 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  const d = await duration($, 'd' + n)
  await w.clock.advance(1000)
  await w.clock.settle()

  return { u, b, d }
}

/** The row is drawn as `<Box />`: a folded turn hides its other rows. */
async function hidden(ui: { drawn: () => Promise<unknown> }): Promise<boolean> {
  const drawn = (await ui.drawn()) as { type?: string; children?: unknown[] }
  return drawn.type === 'Box' && (drawn.children ?? []).length === 0
}

const still = { plugins: [counter], options: { motion: 'off', style: 'boxed' } } as const
const lively = { plugins: [counter], options: { style: 'boxed' } } as const

// ---- no global invalidate at a turn boundary, a click or /folder --------------------------------

test('a turn boundary asks no invalidate: three turns, only the load one, and every row folds and frames', still, async ($, on) => {
  const w = world(on)
  const first = await liveTurn($, w, 1)
  const second = await liveTurn($, w, 2)
  await liveTurn($, w, 3)
  await w.clock.advance(3000)
  await w.clock.settle()
  expect(w.invalidates).toEqual(['ui.render'])
  expect(w.reasonsSince(0)).toEqual(['load'])
  // Turn 1 and turn 2 folded at the next prompt, with no redraw call and no invalidate.
  for (const ui of [first.b, first.d, second.b, second.d]) expect(await hidden(ui)).toBe(true)
  expect(w.logs).toContain('claudefolder: draw AssistantMessage b2 hidden')
  expect(w.logs).toContain('claudefolder: draw UserMessage u2 header-folded')
})

test('turn.complete draws again the rows of that turn alone, once each', still, async ($, on) => {
  const w = world(on)
  const first = await liveTurn($, w, 1)
  await append($, 'u2', 'prompt', 'user', say('test'))
  const u2 = await user($, 'u2')
  await $.turn.start({ text: 'test', turnId: 't2' } as never)
  await append($, 'b2', 'response', 'assistant', say('Hello'))
  const b2 = await assistant($, 'b2')
  await w.clock.settle()
  const mark = w.logs.length
  await $.turn.complete(answerOf('t2'))
  await w.clock.settle()
  const counts = w.dispatchesSince(mark)
  // The prompt and the reply of turn 2 drew it running: each draws once more, framed now.
  expect(counts.get('u2')).toBe(1)
  expect(counts.get('b2')).toBe(1)
  // Turn 1 is folded and did not change: none of its rows is dispatched.
  expect(counts.get('u1') ?? 0).toBe(0)
  expect(counts.get('b1') ?? 0).toBe(0)
  expect(counts.get('d1') ?? 0).toBe(0)
  expect(w.reasonsSince(mark)).toEqual([])
  expect(w.logs).toContain('claudefolder: draw AssistantMessage b2 framed')
  void first
  void u2
  void b2
})

test('a click folds with no invalidate: the header and its rows draw again, no other row', lively, async ($, on) => {
  const w = world(on)
  const first = await liveTurn($, w, 1)
  const second = await liveTurn($, w, 2)
  const mark = w.logs.length
  const before = w.invalidates.length
  await second.u.pointer({ type: 'down', x: 4, y: 0, button: 'left', in: 'folder-head-2' })
  await second.u.pointer({ type: 'up', x: 4, y: 0, button: 'left', in: 'folder-head-2' })
  await w.clock.settle()
  await w.clock.advance(3000)
  await w.clock.settle()
  expect(w.invalidates.length).toBe(before)
  expect(w.reasonsSince(mark)).toEqual([])
  const counts = w.dispatchesSince(mark)
  expect(counts.get('u2') ?? 0).toBeGreaterThanOrEqual(1)
  expect(counts.get('u2') ?? 0).toBeLessThanOrEqual(2)
  expect(counts.get('b2')).toBe(1)
  expect(counts.get('d2')).toBe(1)
  for (const id of ['u1', 'b1', 'd1']) expect(counts.get(id) ?? 0).toBe(0)
  expect(await hidden(second.b)).toBe(true)
  void first
})

test('/folder close all asks no invalidate and writes only the turns it changes', still, async ($, on) => {
  const w = world(on)
  const first = await liveTurn($, w, 1)
  const second = await liveTurn($, w, 2)
  expect((await folder($, 'close 1')).text).toBe('Folded turn #1.')
  await w.clock.settle()
  const mark = w.logs.length
  const written = w.writes.length
  // Turn 1 is folded by a choice already: only turn 2 is written.
  expect((await folder($, 'close all')).text).toBe('Folded 2 turns.')
  await w.clock.advance(1000)
  await w.clock.settle()
  expect(w.writes.slice(written).filter(x => x.key === 'turn').map(x => x.id)).toEqual(['t2'])
  expect(w.reasonsSince(mark)).toEqual([])
  const counts = w.dispatchesSince(mark)
  for (const id of ['u1', 'b1', 'd1']) expect(counts.get(id) ?? 0).toBe(0)
  expect(await hidden(second.b)).toBe(true)
  expect(await hidden(first.b)).toBe(true)
})

// ---- the collapse redraw: only for rows drawn open behind an unseen header, one per burst -------

test('a header first drawn folded asks one invalidate for every turn it hides, and a seen one asks none', still, async ($, on) => {
  const w = world(on)
  // Two turns whose starter rows nobody mounts yet: their headers have not drawn.
  for (const n of [1, 2]) {
    await append($, 'm' + n, 'prompt', 'user', say('reminder'), undefined, true)
    await $.turn.start({ text: '', turnId: 't' + n } as never)
    await append($, 'b' + n, 'response', 'assistant', say('Hello'))
    await $.turn.complete(answerOf('t' + n))
  }
  const b1 = await assistant($, 'b1')
  const b2 = await assistant($, 'b2')
  await liveTurn($, w, 3)
  expect((await folder($, 'close all')).text).toBe('Folded 3 turns.')
  await w.clock.settle()
  // Folded, header unseen: the replies still draw, inside their cards.
  expect(w.logs).toContain('claudefolder: draw AssistantMessage b1 open-unseen')
  expect(w.logs).toContain('claudefolder: draw AssistantMessage b2 open-unseen')
  const mark = w.logs.length
  // Both headers draw in one burst: one collapse invalidate hides both replies.
  await user($, 'm1')
  await user($, 'm2')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.reasonsSince(mark)).toEqual(['collapse'])
  expect(await hidden(b1)).toBe(true)
  expect(await hidden(b2)).toBe(true)
  // Turn 3 folded while its header was on screen: no collapse was ever asked for it.
  expect(w.logs.filter(l => l === 'claudefolder: invalidate collapse')).toHaveLength(1)
})

// ---- the row hops ----------------------------------------------------------------------------

test('a row this load filed reads its turn alone, hidden or not', still, async ($, on) => {
  const w = world(on)
  const first = await liveTurn($, w, 1)
  await liveTurn($, w, 2)
  // Turn 1 is folded: its reply draws hidden, from one read of its turn and no read of its row member.
  const mark = w.reads.length
  await first.b.redraw()
  expect(w.reads.slice(mark)).toEqual([{ key: 'turn', id: 't1' }])
  expect(await hidden(first.b)).toBe(true)
})

test('a tool call whose response row filed its id writes no second row member', still, async ($, on) => {
  const w = world(on)
  await append($, 'u1', 'prompt', 'user', say('test'))
  await $.turn.start({ text: 'test', turnId: 't1' } as never)
  await append($, 'a1', 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }])
  await w.clock.settle()
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_1', input: {} } as never)
  await w.clock.settle()
  expect(w.writes.filter(x => x.key === 'row' && x.id === 'toolu_1')).toHaveLength(1)
  // A call the tracker never saw is still filed.
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_9', input: {} } as never)
  await w.clock.settle()
  expect(w.writes.filter(x => x.key === 'row' && x.id === 'toolu_9')).toHaveLength(1)
  await $.turn.complete(answerOf('t1'))
  const call = await toolUse($, 'toolu_9')
  await w.clock.settle()
  expect(w.logs).toContain('claudefolder: draw ToolUse toolu_9 framed')
  void call
})

test('turn.start reads every earlier turn once per load, then only the turn that just completed', still, async ($, on) => {
  const w = world(on)
  for (const n of [1, 2, 3]) await liveTurn($, w, n)
  const mark = w.reads.length
  await liveTurn($, w, 4)
  const turnReads = w.reads.slice(mark).filter(r => r.key === 'turn').map(r => r.id)
  // Turn 3 completed in this load: it is the only earlier turn turn.start looks at.
  expect(turnReads.filter(id => id === 't1' || id === 't2')).toEqual([])
  expect(turnReads).toContain('t3')
  expect((await folder($, 'open all')).text).toBe('Opened 4 turns.')
})

// ---- the header props ------------------------------------------------------------------------

test('packed cells unpack to the same cells, wide glyphs and astral ones included', () => {
  const cells: HeadCell[] = [
    [0, '╭', 1, -1, 0],
    [1, '─', 1, -1, 0],
    [2, '─', 1, -1, 0],
    [3, '▸', 2, -1, 1],
    [4, ' ', 2, -1, 1],
    [5, '中', 3, -1, 4],
    [7, 'x', 3, -1, 4],
    [8, 'y', 3, -1, 4],
    [9, '\u{1F600}', 3, -1, 4],
    [11, 'z', 3, -1, 4],
  ]
  const packed = packCells(cells)
  expect(packed).toEqual([
    [0, '╭──', 1, -1, 8],
    [3, '▸ ', 2, -1, 9],
    [5, '中', 3, -1, 4],
    [7, 'xy', 3, -1, 12],
    [9, '\u{1F600}', 3, -1, 4],
    [11, 'z', 3, -1, 4],
  ])
})

const STYLES = ['rail', 'boxed', 'zebra', 'rules'] as const

/** A header row by row as the plugin composes it at rest, one cell per column, with flag 4 on the text region. */
function restRows(style: (typeof STYLES)[number], lines: 1 | 2 | 3, folded: boolean, columns: number): HeadCell[][] {
  const m = buildHeader({
    turn: { n: 7, title: 'fix the 中文 login \u{1F600} now', reply: 'Fixed it.', tools: 2, files: ['auth.ts'], durationMs: 41_000, status: 'done' },
    style,
    lines,
    marker: 'triangles',
    edge: 'half',
    palette: PALETTES.dark,
    columns,
    folded,
  })
  const rows = composeRows(createMotion(), 't', m, 'triangles', PALETTES.dark, 'off')
  const texts = composeText(createMotion(), 't', m, PALETTES.dark, 'off')
  return m.rows.map((row, r) =>
    lineCells(rows, texts, m, r).map((c): HeadCell => {
      const region = row.text
      const isText = region !== null && c.col >= region.col && c.col < region.col + region.width
      return [c.col, c.text, c.fg ?? -1, c.bg ?? -1, (c.bold ? 1 : 0) | (c.dim ? 2 : 0) | (isText ? 4 : 0)]
    }),
  )
}

test('every header packs and unpacks to its own cells, and travels many times smaller', () => {
  for (const style of STYLES) {
    for (const lines of [1, 2, 3] as const) {
      for (const folded of [true, false]) {
        for (const columns of [100, 512]) {
          const rows = restRows(style, lines, folded, columns)
          const packed = rows.map(packCells)
          expect(cellsOf(packed)).toEqual(rows)
          if (columns === 512 && style === 'boxed' && lines === 3 && folded) {
            const size = JSON.stringify(packed).length
            expect(size * 5).toBeLessThan(JSON.stringify(rows).length)
            expect(size).toBeLessThan(10_000)
          }
        }
      }
    }
  }
})
