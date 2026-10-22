import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { rowKeyOf } from '../hooks/tracker'
import type { FolderTurn, SavedSession, SavedTurn } from '../types'

// A session's turns are saved in the mod's own store (`$.store`) under `session:<sessionId>` and put back at `session.start`.
// The store is answered by the test itself (four hooks over a Map), so a test reads what the mod saved.

/** What the engine draws beneath the mod, for every component. */
const ENGINE = 'ENGINE'

const VIEWPORT = { columns: 100, rows: 40, isFullscreen: true } as const

type Node = { type?: string; props?: Record<string, unknown>; hover?: unknown; children?: unknown[] }

/**
 * The engine beneath the mod, a session that has an id, and the store; `seed` is what the store holds at the start. A write
 * that would take the store over `cap` characters of JSON is refused, as the engine refuses one over 4 MiB.
 */
function world(on: On, seed: Record<string, unknown> = {}, cap = Infinity) {
  /** Every line the mod logged, in order. */
  const logs: string[] = []
  /** Every write the mod made to its state, in order. */
  const writes: { key: string; value: unknown }[] = []
  /** The session the process runs under: a test changes `id` to go on under another. */
  const session = { id: 'sess-a' }
  /** The store as it stands: the seed, then every write and delete the mod made. */
  const kept = new Map<string, unknown>(Object.entries(seed))
  /** The key of every write the mod made to the store, in order. */
  const sets: string[] = []
  /** The key of every write the store refused, in order. */
  const refused: string[] = []
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
  // The store, answered here in memory as the engine keeps a plugin own (values copied through JSON, as it stores them).
  // `mock.store` registers the same four hooks, and a second hook on one event throws, so the test answers them itself.
  on('store.get', (_$, e) => ({ value: kept.has(e.key) ? (JSON.parse(JSON.stringify(kept.get(e.key))) as unknown) : null }))
  on('store.set', (_$, e) => {
    const value = JSON.parse(JSON.stringify(e.value)) as unknown
    if (JSON.stringify([...new Map(kept).set(e.key, value)]).length > cap) {
      refused.push(e.key)
      throw new Error('a store over its cap')
    }
    kept.set(e.key, value)
    sets.push(e.key)

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    kept.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kept.keys()] }))
  on('session.id', () => ({ value: session.id }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'folder' } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.render', ({ ui }, e) => {
    const { Text } = ui.resolve(e)
    return <Text>{ENGINE}</Text>
  })

  return { logs, writes, session, kept, sets, refused, clock }
}

type World = ReturnType<typeof world>

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

const clients = (node: unknown): Node[] => walk(node).filter(n => n.type === 'Client')

type Drawer = { drawn: (scope?: { in?: string }) => Promise<unknown> }

/** The text of a tree with each Client's text read from what its surface module drew. */
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

const sp = (k: number): string => ' '.repeat(k)

/** Turn `n` folded in the rail style at 100 columns, and its open header. */
const FOLDED = (n: number): string =>
  '▌ ▸ #' + n + ' · fix the login' + sp(76) + '▌   └ Fixed it. · 1 tool · edited auth.ts · 41s' + sp(51)
const OPEN = (n: number): string => '▌ ▾ #' + n + sp(92)

// ---- the rows a transcript is made of ------------------------------------------------------

const append = ($: Engine, uuid: string, door: string, type: string, content: unknown[], name?: string) =>
  $.session.append({
    message: { type, content, ...(name === undefined ? {} : { name }) },
    door,
    origin: door === 'response' ? { kind: 'model', model: 'claude-opus-5-5' } : { kind: 'composer' },
    uuid,
  } as never)

/** One finished main-loop turn `i`: the prompt `u<i>`, a reply with an edit call, its result, the answer `b<i>` and the duration notice `d<i>`. */
async function runTurn($: Engine, i: number) {
  const text = 'fix the login'
  const turnId = 't' + i
  await append($, 'u' + i, 'prompt', 'user', [{ type: 'text', text }])
  await $.turn.start({ text, turnId } as never)
  await append($, 'a' + i, 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_' + i, name: 'Edit', input: {} }])
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\src\\auth.ts' } as never)
  await append($, 'r' + i, 'tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_' + i, content: 'ok' }])
  await append($, 'b' + i, 'response', 'assistant', [{ type: 'text', text: 'Fixed it.' }])
  await $.turn.complete({ answer: 'Fixed it.', durationMs: 41_000, isAborted: false, turnId, reason: 'answer' } as never)
  await append($, 'd' + i, 'notice', 'system', [{ type: 'text', text: 'Baked for 41s' }], 'turn_duration')
}

/** A turn `i` that has started and called a tool, and not ended. */
async function startTurn($: Engine, i: number) {
  const text = 'fix the login'
  await append($, 'u' + i, 'prompt', 'user', [{ type: 'text', text }])
  await $.turn.start({ text, turnId: 't' + i } as never)
  await append($, 'a' + i, 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_' + i, name: 'Edit', input: {} }])
}

const user = ($: Engine, requestId: string) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text: 'x', origin: { kind: 'composer' }, isExpanded: false } as never,
    viewport: VIEWPORT,
  })

const assistant = ($: Engine, requestId: string) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'Fixed it.', isFirstOfReply: true } as never,
    viewport: VIEWPORT,
  })

const duration = ($: Engine, requestId: string) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId,
    props: { word: 'Baked', durationMs: 41_000 } as never,
    viewport: VIEWPORT,
  })

const toolUse = ($: Engine, id: string) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false } as never,
    viewport: VIEWPORT,
  })

/** `/folder <args>`, as the composer runs it. */
const folder = ($: Engine, args: string) =>
  $.command.run({
    command: 'folder',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 100 },
  } as never) as Promise<{ text: string }>

/**
 * The session ends and the process starts again, under the same id or under `goesTo`: the mod's state starts empty (the
 * engine clears `$.state`) and the mod is told to start. The id changes after the end, as the real one does.
 */
async function restart($: Engine, w: World, o: { reason?: 'other' | 'resume'; goesTo?: string } = {}) {
  await $.session.end({ reason: o.reason ?? 'other', sessionId: w.session.id, resume: {} } as never)
  if (o.goesTo !== undefined) w.session.id = o.goesTo
  await $.session.start({ cwd: 'C:\\src', surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** Lets the save's timer run out and its writes finish. */
async function saved(w: World) {
  await w.clock.advance(1500)
  await w.clock.settle()
}

const entryOf = (w: World, id = 'sess-a'): SavedSession => w.kept.get('session:' + id) as SavedSession

/** A saved turn as an earlier run of the mod would have written it. */
const savedTurn = (n: number, over: Partial<SavedTurn> = {}): SavedTurn => ({
  n,
  turnId: 'old' + n,
  title: 'old turn ' + n,
  reply: '',
  tools: 0,
  files: [],
  durationMs: 1000,
  status: 'done',
  folded: true,
  autoFolded: true,
  header: null,
  changedAt: 0,
  closer: null,
  ids: [],
  ...over,
})

const savedSession = (turns: SavedTurn[], nextN: number, savedAt = 1): SavedSession => ({ v: 1, savedAt, nextN, turns })

const still = { options: { motion: 'off' } } as const

// ---- save ----------------------------------------------------------------------------------

test('save: the turns, with their fold states and row keys, are in the store 1.5 s after the changes', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  expect((await folder($, 'open 1')).text).toBe('Opened turn #1.')
  expect(w.kept.has('session:sess-a')).toBe(false)
  await saved(w)
  const entry = entryOf(w)
  expect(entry).toMatchObject({ v: 1, nextN: 3 })
  expect(entry.turns.map(t => t.n)).toEqual([1, 2])
  // Turn 1 folded by itself, then the user opened it; turn 2 is the newest and still open.
  expect(entry.turns[0]).toMatchObject({ turnId: 't1', title: 'fix the login', reply: 'Fixed it.', tools: 1, files: ['auth.ts'], status: 'done', folded: false, autoFolded: true })
  expect(entry.turns[1]).toMatchObject({ turnId: 't2', status: 'done', folded: false, autoFolded: false })
  expect(entry.turns[0]!.ids).toEqual([rowKeyOf('u1'), 'a1', 'toolu_1', 'r1', 'b1', 'd1'])
  expect(entry.turns[1]!.ids).toEqual(['u2', 'a2', 'toolu_2', 'r2', 'b2', 'd2'])
  expect(w.logs).toContain('claudefolder: saved 2 turns')
})

test('save: a burst of changes makes one save, and a later change another', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  await folder($, 'open all')
  await folder($, 'close all')
  await saved(w)
  expect(w.sets).toEqual(['session:sess-a'])
  await folder($, 'open 1')
  await saved(w)
  expect(w.sets).toEqual(['session:sess-a', 'session:sess-a'])
  expect(entryOf(w).turns[0]).toMatchObject({ folded: false })
})

// ---- restore -------------------------------------------------------------------------------

test('restart: the turns come back with their numbers and fold states, and the next prompt carries on', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  await folder($, 'open 1')
  await saved(w)
  await restart($, w)
  expect(w.logs).toContain('claudefolder: restored 2 turns next=3')
  // The engine draws the history again from the transcript: turn 1 is open (the user opened it), turn 2 is open.
  const u1 = await user($, 'u1')
  const u2 = await user($, 'u2')
  expect(await fullText(u1)).toBe(OPEN(1) + ENGINE)
  expect(await fullText(u2)).toBe(OPEN(2) + ENGINE)
  await runTurn($, 3)
  await u1.redraw()
  await u2.redraw()
  // The next prompt folds turn 2, as it would have; turn 1 stays open, the user's choice; the new turn is #3.
  expect(await fullText(u2)).toBe(FOLDED(2))
  expect(await fullText(u1)).toBe(OPEN(1) + ENGINE)
  expect((await folder($, 'close last')).text).toBe('Folded turn #3.')
})

test('restart: a turn saved folded comes back folded, and its other rows hide once the header has drawn', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  await saved(w)
  await restart($, w)
  const u1 = await user($, 'u1')
  expect(await fullText(u1)).toBe(FOLDED(1))
  for (const ui of [await assistant($, 'b1'), await duration($, 'd1'), await toolUse($, 'toolu_1')]) {
    expect(textOf(await ui.drawn())).toBe('')
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
  }
  // The newest turn was open and stays open.
  expect(await fullText(await user($, 'u2'))).toBe(OPEN(2) + ENGINE)
})

for (const [name, options, marks] of [
  ['rail', still, 1],
  ['boxed', { options: { motion: 'off', style: 'boxed' } }, 2],
] as const) {
  test(`restart (${name}): a log row appended after the restored turn's duration line is not part of the turn`, options, async ($, on) => {
    const w = world(on)
    await runTurn($, 1)
    await runTurn($, 2)
    await saved(w)
    await restart($, w)
    await append($, 'log', 'notice', 'system', [{ type: 'text', text: 'claudefolder: options changed' }])
    expect(w.logs).toContain('claudefolder: append notice system composer log -> unassigned')
    const edges = (node: unknown): number => walk(node).filter(n => n.props?.position === 'absolute').length
    const mount = (component: string, requestId: string) =>
      $.ui.mount({ plugin: 'claudefolder', surface: 'terminal', component, requestId, props: { text: 'x' } as never, viewport: VIEWPORT } as never)
    // The header row draws first: a folded turn hides its other rows only once it has.
    await user($, 'u2')
    const b2 = await assistant($, 'b2')
    const log = await mount('CommandOutput', 'log')
    // The restored turn's own row keeps its bar or sides; the log row draws as the engine does, folded turn or not.
    expect(edges(await b2.drawn())).toBe(marks)
    expect(textOf(await log.drawn())).toBe(ENGINE)
    expect(edges(await log.drawn())).toBe(0)
    expect((await folder($, 'close 2')).text).toBe('Folded turn #2.')
    await w.clock.advance(1)
    await b2.redraw()
    await log.redraw()
    expect(textOf(await b2.drawn())).toBe('')
    expect(textOf(await log.drawn())).toBe(ENGINE)
    expect(edges(await log.drawn())).toBe(0)
  })
}

test('restart (boxed): a restored open turn starts its sides at the row first line on screen', { options: { motion: 'off', style: 'boxed' } }, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  await saved(w)
  await restart($, w)
  const tops = async (ui: Drawer): Promise<unknown[]> =>
    walk(await ui.drawn())
      .filter(n => n.props?.position === 'absolute')
      .map(n => n.props?.top)
  // The header draws first, and turn 2 is open.
  await user($, 'u2')
  // b2 is known only through the saved row keys.
  const b2 = await assistant($, 'b2')
  expect(await tops(b2)).toEqual([0, 0])
  await b2.redraw({ text: 'Fixed it.', isFirstOfReply: true, onScreen: { first: 3, last: 8, of: 9 } } as never)
  expect(await tops(b2)).toEqual([3, 3])
  await b2.redraw({ text: 'Fixed it.', isFirstOfReply: true, onScreen: null } as never)
  expect(await tops(b2)).toEqual([])
  expect(textOf(await b2.drawn())).toBe(ENGINE)
})

test('restart: a turn that was running when the session stopped comes back interrupted', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await startTurn($, 2)
  await saved(w)
  expect(entryOf(w).turns[1]).toMatchObject({ turnId: 't2', status: 'running' })
  await restart($, w)
  const member = w.writes
    .filter(x => x.key === 'turn')
    .map(x => x.value as FolderTurn)
    .filter(t => t.turnId === 't2')
    .pop()
  expect(member?.status).toBe('interrupted')
  // It is a finished turn now: /folder counts it.
  expect((await folder($, 'close all')).text).toBe('Folded 2 turns.')
})

test('restart: a session with nothing saved restores nothing and numbers from 1', still, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\src', surface: 'terminal', isInteractive: true } as never)
  expect(w.logs.some(l => l.startsWith('claudefolder: restored'))).toBe(false)
  expect(w.logs).toContain('claudefolder: recovered order=0 next=1 running=none')
  await runTurn($, 1)
  expect(await fullText(await user($, 'u1'))).toBe(OPEN(1) + ENGINE)
  expect((await folder($, 'close last')).text).toBe('Folded turn #1.')
})

test('restart: the entry of another session is left alone', still, async ($, on) => {
  const other = savedSession([savedTurn(1), savedTurn(2)], 3)
  const w = world(on, { 'session:sess-b': other })
  await $.session.start({ cwd: 'C:\\src', surface: 'terminal', isInteractive: true } as never)
  expect(w.logs.some(l => l.startsWith('claudefolder: restored'))).toBe(false)
  expect((await folder($, '')).text).toBe('No finished turn yet.')
})

// ---- the limits ----------------------------------------------------------------------------

test('prune: only the 8 newest sessions stay once this one is saved', still, async ($, on) => {
  const seed: Record<string, unknown> = {}
  for (let i = 1; i <= 9; i++) seed['session:s' + i] = savedSession([savedTurn(1)], 2, i)
  const w = world(on, seed)
  await runTurn($, 1)
  await saved(w)
  const keys = [...w.kept.keys()].filter(k => k.startsWith('session:')).sort()
  expect(keys).toEqual(['session:s3', 'session:s4', 'session:s5', 'session:s6', 'session:s7', 'session:s8', 'session:s9', 'session:sess-a'])
})

test(
  'a session with 250 turns saves the newest 200',
  { options: { motion: 'off' }, timeoutMs: 30_000 },
  async ($, on) => {
    const turns = Array.from({ length: 250 }, (_, i) => savedTurn(i + 1))
    const w = world(on, { 'session:sess-a': savedSession(turns, 251) })
    await $.session.start({ cwd: 'C:\\src', surface: 'terminal', isInteractive: true } as never)
    expect(w.logs).toContain('claudefolder: restored 250 turns next=251')
    await runTurn($, 1)
    await saved(w)
    const entry = entryOf(w)
    expect(entry.turns.length).toBe(200)
    expect(entry.turns[0]!.n).toBe(52)
    expect(entry.turns[199]).toMatchObject({ n: 251, turnId: 't1' })
    expect(entry.nextN).toBe(252)
  },
)

// ---- a store that holds something unusable -------------------------------------------------

const MALFORMED: [string, unknown][] = [
  ['another version', { v: 2, savedAt: 1, nextN: 2, turns: [savedTurn(1)] }],
  ['not an object', 'turns'],
  ['no turn list', { v: 1, savedAt: 1, nextN: 2, turns: 'none' }],
  ['turns of the wrong types', { v: 1, savedAt: 1, nextN: 2, turns: [5, null, { n: 'x' }, { ...savedTurn(1), files: 'a.ts' }, { ...savedTurn(2), status: 'lost' }] }],
]

for (const [name, entry] of MALFORMED) {
  test(`restart: an entry that is ${name} restores nothing and does not throw`, still, async ($, on) => {
    const w = world(on, { 'session:sess-a': entry })
    await $.session.start({ cwd: 'C:\\src', surface: 'terminal', isInteractive: true } as never)
    expect(w.logs.some(l => l.startsWith('claudefolder: restored'))).toBe(false)
    await runTurn($, 1)
    expect((await folder($, 'close last')).text).toBe('Folded turn #1.')
  })
}

test('restart: a malformed turn is dropped and the valid ones around it come back', still, async ($, on) => {
  const entry = savedSession([savedTurn(1), { ...savedTurn(2), tools: 'many' } as unknown as SavedTurn, savedTurn(3)], 4)
  const w = world(on, { 'session:sess-a': entry })
  await $.session.start({ cwd: 'C:\\src', surface: 'terminal', isInteractive: true } as never)
  expect(w.logs).toContain('claudefolder: restored 2 turns next=4')
  expect((await folder($, 'open all')).text).toBe('Opened 2 turns.')
  expect((await folder($, 'open 2')).text).toBe('No turn #2.')
})

// ---- a session switch ----------------------------------------------------------------------

test('session switch: the process goes on under another id and restores that session only', still, async ($, on) => {
  const b = savedSession([savedTurn(1, { title: 'the other session' })], 2)
  const w = world(on, { 'session:sess-b': b })
  await runTurn($, 1)
  await runTurn($, 2)
  await saved(w)
  expect(entryOf(w).turns.length).toBe(2)
  // A resume: session A ends, the process continues under B, and its own turns come back, not A's.
  await restart($, w, { reason: 'resume', goesTo: 'sess-b' })
  expect(w.logs).toContain('claudefolder: restored 1 turns next=2')
  expect((await folder($, 'open all')).text).toBe('Opened 1 turn.')
  expect((await folder($, 'open 2')).text).toBe('No turn #2.')
  // A's entry was flushed when it ended and B has not touched it.
  expect(entryOf(w, 'sess-a').turns.map(t => t.turnId)).toEqual(['t1', 't2'])
  // The next prompt under B is #2, and is saved under B.
  await runTurn($, 5)
  await saved(w)
  expect(entryOf(w, 'sess-b').turns.map(t => t.turnId)).toEqual(['old1', 't5'])
  expect(entryOf(w, 'sess-b').turns.map(t => t.n)).toEqual([1, 2])
  expect(entryOf(w, 'sess-a').turns.map(t => t.turnId)).toEqual(['t1', 't2'])
})

test('a /clear saves the session that ends, and the new one starts from turn 1', still, async ($, on) => {
  const w = world(on)
  await runTurn($, 1)
  await runTurn($, 2)
  // No save timer has run: the end flushes it.
  expect(w.kept.has('session:sess-a')).toBe(false)
  await $.session.end({ reason: 'clear', sessionId: 'sess-a', resume: {} } as never)
  // The process goes on under another id; no session.start fires for a /clear.
  w.session.id = 'sess-c'
  expect(entryOf(w).turns.map(t => t.n)).toEqual([1, 2])
  expect((await folder($, '')).text).toBe('No finished turn yet.')
  await runTurn($, 9)
  expect((await folder($, 'close last')).text).toBe('Folded turn #1.')
  await saved(w)
  expect(entryOf(w, 'sess-c').turns.map(t => t.n)).toEqual([1])
})

// ---- a full store (v9) -----------------------------------------------------------------------

/** Another session's entry of about 3,200 characters, saved at `savedAt`. */
const bulky = (savedAt: number): SavedSession => savedSession([savedTurn(1, { title: 'x'.repeat(3000) })], 2, savedAt)

test('a full store: the refused save prunes the other sessions to the two newest and is tried once more', still, async ($, on) => {
  const seed: Record<string, unknown> = {}
  for (let i = 1; i <= 7; i++) seed['session:s' + i] = bulky(i)
  const w = world(on, seed, 22_000)
  await runTurn($, 1)
  await saved(w)
  expect(w.refused).toEqual(['session:sess-a'])
  expect([...w.kept.keys()].sort()).toEqual(['session:s6', 'session:s7', 'session:sess-a'])
  expect(entryOf(w).turns.map(t => t.turnId)).toEqual(['t1'])
  expect(w.logs).toContain('claudefolder: saved 1 turns')
  // The next save fits at once.
  await folder($, 'close 1')
  await saved(w)
  expect(w.refused).toEqual(['session:sess-a'])
  expect(entryOf(w).turns[0]).toMatchObject({ folded: true })
})

test('the older sessions are pruned before the first save of the process, so a store at its cap takes it at once', still, async ($, on) => {
  const seed: Record<string, unknown> = {}
  for (let i = 1; i <= 9; i++) seed['session:s' + i] = bulky(i)
  const w = world(on, seed, 27_000)
  await runTurn($, 1)
  await saved(w)
  expect(w.refused).toEqual([])
  const keys = [...w.kept.keys()].filter(k => k.startsWith('session:')).sort()
  expect(keys).toEqual(['session:s3', 'session:s4', 'session:s5', 'session:s6', 'session:s7', 'session:s8', 'session:s9', 'session:sess-a'])
})

test(
  'a session over the budget saves its newest turns that fit',
  { options: { motion: 'off' }, timeoutMs: 30_000 },
  async ($, on) => {
    const ids = (n: number) => Array.from({ length: 400 }, (_, i) => 'toolu_' + n + '_' + String(i).padStart(24, '0'))
    const turns = Array.from({ length: 200 }, (_, i) => savedTurn(i + 1, { ids: ids(i + 1) }))
    const w = world(on, { 'session:sess-a': savedSession(turns, 201) })
    await $.session.start({ cwd: 'C:\\src', surface: 'terminal', isInteractive: true } as never)
    await runTurn($, 1)
    await saved(w)
    const entry = entryOf(w)
    expect(JSON.stringify(entry).length).toBeLessThanOrEqual(400_000)
    expect(entry.turns.length).toBeGreaterThan(1)
    expect(entry.turns[entry.turns.length - 1]).toMatchObject({ turnId: 't1', n: 201 })
    expect(entry.turns[0]!.n).toBeGreaterThan(2)
    expect(entry.nextN).toBe(202)
  },
)

test('rows filed while a turn runs are saved within 10 s, before it ends', still, async ($, on) => {
  const w = world(on)
  await startTurn($, 1)
  await saved(w)
  expect(entryOf(w).turns[0]!.ids).toEqual(['u1', 'a1', 'toolu_1'])
  await append($, 'r1', 'tool-result', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }])
  await append($, 'b1', 'response', 'assistant', [{ type: 'text', text: 'Fixed it.' }])
  await w.clock.advance(9_000)
  await w.clock.settle()
  expect(entryOf(w).turns[0]!.ids).toEqual(['u1', 'a1', 'toolu_1'])
  await w.clock.advance(1_000)
  await w.clock.settle()
  expect(entryOf(w).turns[0]!.ids).toEqual(['u1', 'a1', 'toolu_1', 'r1', 'b1'])
})
