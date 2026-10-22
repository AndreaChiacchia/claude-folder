import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// The real engine's order of events, with no `redraw()` before an assertion: a row drawn while the turn ran must update
// by itself when the turn ends (the kit redraws mounted rows on the mod's state writes and on its invalidates).
// Concurrency is modelled with `Promise.all`: `session.append` overlaps `turn.start` and `turn.complete`.

/** What the engine draws beneath the mod, for every component. */
const ENGINE = 'ENGINE'

const VIEWPORT = { columns: 100, rows: 40, isFullscreen: true } as const

type Node = { type?: string; props?: Record<string, unknown>; hover?: unknown; children?: unknown[] }

/** The engine beneath the mod: every component draws ENGINE, tools and turns answer. */
function world(on: On) {
  /** Every line the mod logged, in order (the debug lines of its decisions among them). */
  const logs: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.log', (_$, e, next) => {
    logs.push(e.text)

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

  return { logs, clock }
}

type World = ReturnType<typeof world>

const keyOf = (n: Node): string => String(n.props?.key ?? (n as { key?: unknown }).key)

/** The text a tree reads as; the absolutely placed edge bars of an open turn's rows are left out. */
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

const buttons = (node: unknown): Node[] => walk(node).filter(n => n.type === 'Button')

/** How many absolutely placed boxes a drawn tree holds: the two sides of a framed row. */
const sidesOf = (node: unknown): number => walk(node).filter(n => n.props?.position === 'absolute').length

/** The key of turn `n`'s header Client. */
const head = (n: number): string => 'folder-head-' + n

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

/** The row is drawn as `<Box />`: a folded turn's other rows. */
async function expectHidden(ui: Drawer): Promise<void> {
  const drawn = await ui.drawn()
  expect(drawn).toMatchObject({ type: 'Box' })
  expect(textOf(drawn)).toBe('')
}

/**
 * The row is drawn as a row of an open boxed card: the engine's row between the card's two sides. With the card's light on
 * (Lively or Subtle) the sides are bar Clients (`bars`: how many Clients the row holds); otherwise plain Text.
 */
async function expectFramed(ui: Drawer, bars = 0): Promise<void> {
  const drawn = await ui.drawn()
  expect(textOf(drawn).startsWith(ENGINE)).toBe(true)
  expect(sidesOf(drawn)).toBe(2)
  expect(clients(drawn).length).toBe(bars)
}

/** Lets the writes and the timers the last call started finish. */
async function quiet(w: World, ms = 1): Promise<void> {
  await w.clock.advance(ms)
  await w.clock.settle()
}

// ---- the rows a transcript is made of ------------------------------------------------------

const append = (
  $: Engine,
  uuid: string,
  door: string,
  type: string,
  content: unknown[],
  name?: string,
  isMeta = false,
  origin?: string,
) =>
  $.session.append({
    message: { type, content, ...(name === undefined ? {} : { name }), ...(isMeta ? { isMeta: true } : {}) },
    door,
    origin: door === 'response' ? { kind: 'model', model: 'claude-opus-5-5' } : { kind: origin ?? 'composer' },
    uuid,
  } as never)

const say = (t: string) => [{ type: 'text', text: t }]

const user = ($: Engine, requestId: string, props: Record<string, unknown> = {}) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text: 'test', origin: { kind: 'composer' }, isExpanded: false, ...props } as never,
    viewport: VIEWPORT,
  })

const assistant = ($: Engine, requestId: string, props: Record<string, unknown> = {}) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text: 'Hello', isFirstOfReply: true, ...props } as never,
    viewport: VIEWPORT,
  })

const duration = ($: Engine, requestId: string, durationMs: number, props: Record<string, unknown> = {}) =>
  $.ui.mount({
    plugin: 'claudefolder',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId,
    props: { word: 'Churned', durationMs, ...props } as never,
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

/** `/folder <args>`, as the composer runs it. */
const folder = ($: Engine, args: string) =>
  $.command.run({
    command: 'folder',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 100 },
  } as never) as Promise<{ text: string }>

type Poster = { post: (data: { type: string }, scope?: { in?: string }) => Promise<void> }

/**
 * The header Client of turn `n` fails on its surface, for real: the mod answers this post with props the module cannot
 * draw, the module throws, and the engine tells the plugin's `ui.fault` hook (the test engine cannot raise that itself).
 */
const fault = (ui: Poster, n: number): Promise<void> => ui.post({ type: 'fault' }, { in: head(n) }).catch(() => undefined)

const boxedStill = { options: { motion: 'off', style: 'boxed' } } as const
const boxed = { options: { style: 'boxed' } } as const

/** The open card's top line of turn `n` (one digit) at 100 columns: the marker and the number alone. */
const cardTop = (n: number): string => '╭─ ▾ #' + n + ' ' + '─'.repeat(89) + '╮'

const cardBottom = '╰' + '─'.repeat(96) + '╯'

const ATTACHMENTS = ['environment', 'deferred_tools_delta', 'mcp_instructions_delta', 'total_tokens_reminder', 'deferred_tools_record']

/** The attachment rows the engine appends right after a prompt, one after the other. */
async function attach($: Engine, n: number): Promise<void> {
  for (let i = 0; i < ATTACHMENTS.length; i++) await append($, n + 'att' + i, 'attachment', 'attachment', [], ATTACHMENTS[i])
}

const answerOf = (turnId: string) => ({ answer: 'Hello', durationMs: 4000, isAborted: false, turnId, reason: 'answer' }) as never

/**
 * One turn `n` in the engine's order: the prompt `u<n>` is appended and drawn, the turn starts while the attachments are
 * appended, the reply `b<n>` is appended and drawn, the turn completes while its duration notice `d<n>` is appended, which
 * is then drawn. With `startFirst` the turn starts before the prompt's row is appended. Ends a second later; no redraw.
 */
async function liveTurn($: Engine, w: World, n: number, o: { startFirst?: boolean } = {}) {
  const turnId = 't' + n
  const start = () => $.turn.start({ text: 'test', turnId } as never)
  let u: Awaited<ReturnType<typeof user>>
  if (o.startFirst === true) {
    await start()
    await append($, 'u' + n, 'prompt', 'user', say('test'))
    u = await user($, 'u' + n)
    await attach($, n)
  } else {
    await append($, 'u' + n, 'prompt', 'user', say('test'))
    u = await user($, 'u' + n)
    await Promise.all([start(), attach($, n)])
  }
  await append($, 'b' + n, 'response', 'assistant', say('Hello'))
  const b = await assistant($, 'b' + n)
  await Promise.all([$.turn.complete(answerOf(turnId)), append($, 'd' + n, 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  const d = await duration($, 'd' + n, 4000)
  await w.clock.advance(1000)

  return { u, b, d }
}

const STYLES = [
  ['still', boxedStill],
  ['lively', boxed],
] as const

// ---- the live order, no redraw ---------------------------------------------------------------

for (const [name, options] of STYLES) {
  // The sides and the bottom are plain Text in both: the header is the only Client.
  const lively = name === 'lively'
  const bars = 0
  const bottom = ENGINE + cardBottom
  /** The folded card's marker is `▸` before the number; under Lively a fold still in its first frame shows the marker it flips from. */
  const foldedMark = lively ? /[▸▾] #1/ : /▸ #1/

  test(`real order, no redraw (${name}): the prompt and the reply sit inside the card, the duration line closes it`, options, async ($, on) => {
    const w = world(on)
    const { u, b, d } = await liveTurn($, w, 1)
    expect(await fullText(u)).toBe(cardTop(1) + ENGINE)
    await expectFramed(b, bars)
    expect(textOf(await b.drawn())).toBe(ENGINE)
    const drawnD = await d.drawn()
    expect(textOf(drawnD)).toBe(bottom)
    expect(sidesOf(drawnD)).toBe(2)
    expect(clients(drawnD).length).toBe(0)
    const running = w.logs.indexOf('claudefolder: draw UserMessage u1 running')
    const open = w.logs.indexOf('claudefolder: draw UserMessage u1 header-open')
    expect(running).toBeGreaterThanOrEqual(0)
    expect(open).toBeGreaterThan(running)
    // The turn's own write drew its rows again: no invalidate.
    expect(w.logs).not.toContain('claudefolder: invalidate turn.complete')
  })

  test(`turn.start before the prompt's append (${name}): the same result`, options, async ($, on) => {
    const w = world(on)
    const { u, b, d } = await liveTurn($, w, 1, { startFirst: true })
    expect(await fullText(u)).toBe(cardTop(1) + ENGINE)
    await expectFramed(b, bars)
    expect(textOf(await d.drawn())).toBe(bottom)
    expect(w.logs).toContain('claudefolder: draw UserMessage u1 header-open')
    expect(w.logs).not.toContain('claudefolder: invalidate turn.complete')
  })

  test(`the next prompt folds the previous turn without redraws (${name})`, options, async ($, on) => {
    const w = world(on)
    const first = await liveTurn($, w, 1)
    const second = await liveTurn($, w, 2)
    await w.clock.advance(3000)
    const folded = await fullText(first.u)
    expect(folded).toMatch(foldedMark)
    expect(folded).toContain('#1')
    await expectHidden(first.b)
    await expectHidden(first.d)
    expect(w.logs).toContain('claudefolder: draw AssistantMessage b1 hidden')
    expect(w.logs).not.toContain('claudefolder: invalidate turn.start')
    expect(await fullText(second.u)).toBe(cardTop(2) + ENGINE)
    await expectFramed(second.b, bars)
  })
}

test('a row that took the expanded path still follows its turn', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'u1', 'prompt', 'user', say('test'))
  await $.turn.start({ text: 'test', turnId: 't1' } as never)
  await append($, 'b1', 'response', 'assistant', say('Hello'))
  // A row drawn in full (ctrl+o) sets the view flag; the reply drawn under it is the engine's.
  const x = await duration($, 'x1', 1, { isExpanded: true })
  const b = await assistant($, 'b1')
  expect(textOf(await b.drawn())).toBe(ENGINE)
  expect(sidesOf(await b.drawn())).toBe(0)
  // The view goes back to the normal one; the row that said otherwise is gone, so no redraw can bring the flag back.
  await duration($, 'y1', 1, { isExpanded: false })
  await x.unmount()
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  await w.clock.advance(1000)
  await expectFramed(b)
})

test('an agent message under a label does not flip the view', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'u1', 'prompt', 'user', say('test'))
  const u = await user($, 'u1')
  await $.turn.start({ text: 'test', turnId: 't1' } as never)
  await append($, 'b1', 'response', 'assistant', say('Hello'))
  // The message is drawn whole under its label even in the normal view: its flag says nothing about the view.
  await user($, 'p1', { text: 'from an agent', from: { name: 'general-purpose' }, isExpanded: true })
  const b = await assistant($, 'b1')
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  await w.clock.advance(1000)
  await expectFramed(b)
  expect(await fullText(u)).toBe(cardTop(1) + ENGINE)
})

// ---- turns that do not start with a typed prompt ---------------------------------------------

test('a hand-back turn folds onto the agent message, and its other rows hide', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'h1', 'prompt', 'user', say('agent output'), undefined, true, 'peer')
  const h = await user($, 'h1', { text: 'agent output', origin: { kind: 'peer' }, from: { name: 'general-purpose' } })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await append($, 'a1', 'response', 'assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }])
  const g = await group($, 'grp1', ['toolu_1'])
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  const d = await duration($, 'd1', 4000)
  await w.clock.advance(1000)
  await liveTurn($, w, 2)
  await w.clock.advance(3000)
  const folded = await fullText(h)
  expect(folded).toContain('Message from @general-purpose')
  expect(folded).toContain('▸')
  expect(folded).toContain('#1')
  await expectHidden(g)
  await expectHidden(d)
})

test('a notification turn folds onto the notification line', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'n1', 'delivery', 'attachment', say('Agent "build" finished'), 'queued_command')
  const n = await user($, 'n1', { text: 'Agent "build" finished', task: { id: 'x' } })
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await append($, 'b1', 'response', 'assistant', say('Noted.'))
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  await w.clock.advance(1000)
  await liveTurn($, w, 2)
  await w.clock.advance(3000)
  const folded = await fullText(n)
  expect(folded).toContain('Agent "build" finished')
  expect(folded).toContain('▸')
  expect(folded).toContain('#1')
})

test('a notification that no turn follows draws inside the turn before and folds with it', boxedStill, async ($, on) => {
  const w = world(on)
  const first = await liveTurn($, w, 1)
  await append(
    $,
    'n1',
    'prompt',
    'user',
    say('<task-notification>\n<task-id>a</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>'),
    undefined,
    false,
    'task-notification',
  )
  const n = await user($, 'n1', { text: 'Agent "x" finished', origin: { kind: 'task-notification' }, task: { id: 'a', status: 'completed' } })
  // While it waits, the engine draws it.
  expect(textOf(await n.drawn())).toBe(ENGINE)
  expect(sidesOf(await n.drawn())).toBe(0)
  // The person types instead: the notification started no turn, so it joins the turn before.
  await append($, 'u2', 'prompt', 'user', say('test'))
  const u = await user($, 'u2')
  await quiet(w)
  expect(textOf(await n.drawn())).toBe(ENGINE + cardBottom)
  expect(sidesOf(await n.drawn())).toBe(2)
  expect(textOf(await first.d.drawn())).toBe(ENGINE)
  expect(sidesOf(await first.d.drawn())).toBe(2)
  expect(w.logs).toContain('claudefolder: append prompt user composer u2 -> pending typed, moved 1 to tail 1')
  // Turn 2, in the engine's order.
  await Promise.all([$.turn.start({ text: 'test', turnId: 't2' } as never), attach($, 2)])
  await append($, 'b2', 'response', 'assistant', say('Hello'))
  await Promise.all([$.turn.complete(answerOf('t2')), append($, 'd2', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  await w.clock.advance(1000)
  await w.clock.advance(3000)
  expect(await fullText(first.u)).toMatch(/▸ #1/)
  await expectHidden(n)
  await expectHidden(first.d)
  expect(await fullText(u)).toBe(cardTop(2) + ENGINE)
})

test('a notification that arrives after the duration line but before the turn completes closes the card under it', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'u1', 'prompt', 'user', say('test'))
  const u = await user($, 'u1')
  await Promise.all([$.turn.start({ text: 'test', turnId: 't1' } as never), attach($, 1)])
  await append($, 'b1', 'response', 'assistant', say('Hello'))
  const b = await assistant($, 'b1')
  await append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')
  const d = await duration($, 'd1', 4000)
  // The notification comes before the engine's `turn.complete` reached the mod: the turn still runs for the tracker.
  await append(
    $,
    'n1',
    'prompt',
    'user',
    say('<task-notification>\n<task-id>a</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>'),
    undefined,
    false,
    'task-notification',
  )
  const n = await user($, 'n1', { text: 'Agent "x" finished', origin: { kind: 'task-notification' }, task: { id: 'a', status: 'completed' } })
  await $.turn.complete(answerOf('t1'))
  await quiet(w)
  expect(textOf(await n.drawn())).toBe(ENGINE + cardBottom)
  expect(sidesOf(await n.drawn())).toBe(2)
  expect(textOf(await d.drawn())).toBe(ENGINE)
  expect(sidesOf(await d.drawn())).toBe(2)
  expect(textOf(await b.drawn())).toBe(ENGINE)
  expect(await fullText(u)).toBe(cardTop(1) + ENGINE)
})

const SKILL = 'Base directory for this skill: C:\\skills\\iwo'
const SKILL_COMMAND =
  '<command-message>iwo</command-message>\n<command-name>/iwo</command-name>\n<command-args>balanced fix it</command-args>'

// The engine draws the person's command line (`> /iwo balanced fix it`) itself, through no render site: it is never mounted.
test('a skill whose expanded text is appended before its command row folds onto its first reply', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 's1', 'prompt', 'user', say(SKILL), undefined, true, 'unclassified')
  await append($, 'c1', 'command', 'user', say(SKILL_COMMAND))
  await $.turn.start({ text: SKILL, turnId: 't1' } as never)
  await attach($, 1)
  await append($, 'b1', 'response', 'assistant', say('Hello'))
  const b = await assistant($, 'b1')
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  const d = await duration($, 'd1', 4000)
  await w.clock.advance(1000)
  await liveTurn($, w, 2)
  await w.clock.advance(3000)
  const folded = await fullText(b)
  expect(folded).toMatch(/▸ #1/)
  expect(folded).toContain('/iwo balanced fix it')
  expect(folded).not.toContain('Base directory')
  await expectHidden(d)
  expect(w.logs).toContain('claudefolder: turn.start 1 t1 header=none start=other adopted=2')
  expect(w.logs).toContain('claudefolder: turn.complete 1 header=b1 closer=d1 status=done')
})

test('the command row first, then its expanded text (the usual order): the turn folds onto its first reply', boxedStill, async ($, on) => {
  const w = world(on)
  await append($, 'c1', 'command', 'user', say(SKILL_COMMAND))
  await append($, 's1', 'prompt', 'user', say(SKILL), undefined, true, 'unclassified')
  await $.turn.start({ text: SKILL, turnId: 't1' } as never)
  await attach($, 1)
  await append($, 'b1', 'response', 'assistant', say('Hello'))
  const b = await assistant($, 'b1')
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  const d = await duration($, 'd1', 4000)
  await w.clock.advance(1000)
  await liveTurn($, w, 2)
  await w.clock.advance(3000)
  const folded = await fullText(b)
  expect(folded).toMatch(/▸ #1/)
  expect(folded).toContain('/iwo balanced fix it')
  expect(folded).not.toContain('Base directory')
  await expectHidden(d)
  expect(w.logs).toContain('claudefolder: turn.start 1 t1 header=none start=other adopted=2')
  expect(w.logs).toContain('claudefolder: turn.complete 1 header=b1 closer=d1 status=done')
})

test("the turn starts before the skill's rows: the turn folds onto its first reply, titled with the command", boxedStill, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: SKILL, turnId: 't1' } as never)
  await append($, 's1', 'prompt', 'user', say(SKILL), undefined, true, 'unclassified')
  await append($, 'c1', 'command', 'user', say(SKILL_COMMAND))
  await attach($, 1)
  await append($, 'b1', 'response', 'assistant', say('Hello'))
  const b = await assistant($, 'b1')
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  const d = await duration($, 'd1', 4000)
  await w.clock.advance(1000)
  await liveTurn($, w, 2)
  await w.clock.advance(3000)
  const folded = await fullText(b)
  expect(folded).toMatch(/▸ #1/)
  expect(folded).toContain('/iwo balanced fix it')
  expect(folded).not.toContain('Base directory')
  await expectHidden(d)
  expect(w.logs).toContain('claudefolder: turn.complete 1 header=b1 closer=d1 status=done')
})

test('a header that never draws: the turn never vanishes', boxedStill, async ($, on) => {
  const w = world(on)
  // A meta starter that nobody mounts: the turn's header row never draws.
  await append($, 'm1', 'prompt', 'user', say('reminder'), undefined, true)
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await append($, 'b1', 'response', 'assistant', say('Hello'))
  const b = await assistant($, 'b1')
  await Promise.all([$.turn.complete(answerOf('t1')), append($, 'd1', 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  await w.clock.advance(1000)
  await liveTurn($, w, 2)
  // Turn 1 is folded now, but its header has not drawn: the reply still draws, inside the card.
  await expectFramed(b)
  expect(w.logs).toContain('claudefolder: draw AssistantMessage b1 open-unseen')
  // The header draws at last: it shows the folded card, and a redraw asked for the other rows hides the reply.
  const m = await user($, 'm1', { text: 'reminder' })
  await quiet(w, 100)
  expect(await fullText(m)).toContain('▸')
  await expectHidden(b)
})

// ---- state, old lines, clicks, commands, recovery --------------------------------------------

test('a draw writes no state: only row, turn and order are ever written', boxed, async ($, on) => {
  const w = world(on)
  const keys = new Set<string>()
  on('state.set', (_$, e, next) => {
    const write = e as unknown as { plugin?: string; key?: string }
    if (write.plugin === 'claudefolder' && typeof write.key === 'string') keys.add(write.key)

    return next(e)
  })
  await liveTurn($, w, 1)
  await liveTurn($, w, 2)
  await liveTurn($, w, 3, { startFirst: true })
  await w.clock.advance(3000)
  expect(keys.has('drawn')).toBe(false)
  expect(keys.has('light')).toBe(false)
  expect(keys.has('turn')).toBe(true)
  expect([...keys].filter(k => !['row', 'turn', 'order'].includes(k))).toEqual([])
})

test('a click fold hands the header the complete folded card in its first frame, and asks no invalidate', boxed, async ($, on) => {
  const w = world(on)
  await liveTurn($, w, 1)
  const second = await liveTurn($, w, 2)
  const u = second.u
  const redraws = (): number => w.logs.filter(l => l === 'claudefolder: invalidate toggle').length
  const before = redraws()
  // A click on the open header's marker and number folds the turn.
  await click(u, head(2), 4, 0)
  await w.clock.settle()
  const props = clients(await u.drawn()).find(c => keyOf(c) === head(2))?.props?.props as { fx?: { kind: string; age: number }; rows: [number, string][][] } | undefined
  expect(props?.fx).toMatchObject({ kind: 'fold', age: 0 })
  // Its first frame holds every cell of the folded card: four rows of 98 cells, the sides and the bottom border among them.
  const cells = props?.rows.map(r => r.map(c => c[1]).join('')) ?? []
  expect(cells.length).toBe(4)
  expect(cells.every(c => c.length === 98)).toBe(true)
  expect(cells[1]!.endsWith('│')).toBe(true)
  expect(cells[3]).toBe('╰' + '─'.repeat(96) + '╯')
  // The turn's write draws its rows again: no invalidate, then or later.
  expect(redraws()).toBe(before)
  await w.clock.advance(300)
  await w.clock.settle()
  expect(redraws()).toBe(before)
})

test('old duration lines stay theirs: one nobody filed draws as the engine does, folded turn or not', boxedStill, async ($, on) => {
  const w = world(on)
  await liveTurn($, w, 1)
  // Same duration as turn 1, but a row the mod never filed (a line from before a restart).
  const old = await duration($, 'old', 4000)
  expect(textOf(await old.drawn())).toBe(ENGINE)
  expect(sidesOf(await old.drawn())).toBe(0)
  await liveTurn($, w, 2)
  await w.clock.advance(3000)
  expect(textOf(await old.drawn())).toBe(ENGINE)
  expect(sidesOf(await old.drawn())).toBe(0)
})

test('click and fallback still work after the redesign, with no redraw call', boxed, async ($, on) => {
  const w = world(on)
  await liveTurn($, w, 1)
  const second = await liveTurn($, w, 2)
  const u = second.u
  expect(await fullText(u)).toBe(cardTop(2) + ENGINE)
  // A click on the open header's marker and number folds the turn (a fold's first frame shows the marker it flips from).
  await click(u, head(2), 4, 0)
  await quiet(w)
  await w.clock.advance(3000)
  expect(await fullText(u)).toMatch(/[▸▾] #2/)
  // The header module fails: every header falls back to Buttons over the text.
  await fault(u, 2)
  await quiet(w)
  const fallback = await u.drawn()
  expect(clients(fallback)).toEqual([])
  expect(buttons(fallback).map(keyOf)).toEqual(['fold-2'])
  await u.press({ key: 'fold-2' })
  await quiet(w)
  await w.clock.advance(3000)
  const open = await u.drawn()
  expect(buttons(open).map(keyOf)).toEqual(['fold-2'])
  expect(textOf(open)).toContain('▾ #2')
})

test('/folder close and /folder open redraw the rows with no redraw call and no invalidate', boxedStill, async ($, on) => {
  const w = world(on)
  const first = await liveTurn($, w, 1)
  await liveTurn($, w, 2)
  expect((await folder($, 'open 1')).text).toBe('Opened turn #1.')
  await quiet(w)
  expect(await fullText(first.u)).toBe(cardTop(1) + ENGINE)
  await expectFramed(first.b)
  expect((await folder($, 'close 1')).text).toBe('Folded turn #1.')
  await quiet(w)
  expect(await fullText(first.u)).toContain('▸ #1')
  await expectHidden(first.b)
  await quiet(w, 300)
  expect(w.logs).not.toContain('claudefolder: invalidate folder')
})

test('recovery from the first hook: two turns with no session.start, the second is #2 and the load says so once', boxedStill, async ($, on) => {
  const w = world(on)
  for (const n of [1, 2]) {
    await append($, 'u' + n, 'prompt', 'user', say('test'))
    await $.turn.start({ text: 'test', turnId: 't' + n } as never)
    await append($, 'b' + n, 'response', 'assistant', say('Hello'))
    await $.turn.complete(answerOf('t' + n))
    await append($, 'd' + n, 'notice', 'system', say('Churned for 4s'), 'turn_duration')
  }
  expect((await folder($, 'close last')).text).toBe('Folded turn #2.')
  expect(w.logs.filter(l => l.startsWith('claudefolder: recovered'))).toEqual(['claudefolder: recovered order=0 next=1 running=none'])
  expect(w.logs).toContain('claudefolder: append prompt user composer u1 -> pending typed')
  expect(w.logs).toContain('claudefolder: turn.start 1 t1 header=u1 start=typed adopted=1')
  expect(w.logs).toContain('claudefolder: append response assistant model b1 -> turn 1')
  expect(w.logs).toContain('claudefolder: append notice system turn_duration composer d1 -> tail 1')
  expect(w.logs).toContain('claudefolder: turn.complete 1 header=u1 closer=b1 status=done')
  expect(w.logs).toContain('claudefolder: turn.start 2 t2 header=u2 start=typed adopted=1')
})

// ---- the engine's real row keys ----------------------------------------------------------------
// The engine draws a prompt and a reply under their uuid with the last group (12 hex digits) zeroed, a tool group under
// `collapsed-` and that key, and the duration line under its full uuid; `session.append` carries the full uuids.

/** The key the engine draws a row under: its uuid with the last group zeroed. */
const zeroed = (uuid: string): string => uuid.slice(0, 24) + '000000000000'

const REAL = {
  1: { u: 'b6d78f44-8266-4aaa-84e5-0041bd1ce1bd', b: 'a7915ca1-3543-4154-ba44-3c853b06afae', d: '714515a1-38d9-409f-9e15-602df80d2cb3' },
  2: { u: '4575fcb2-1bcf-415c-8c36-00be9fd57d2e', b: 'c3d1e2f4-0a5b-4c6d-8e7f-1a2b3c4d5e6f', d: '06d0e791-c7b7-46cb-a051-dd7f03333b9b' },
} as const

/** One turn `n` as the engine really keys it: appended under full uuids, the prompt and the reply drawn under zeroed keys. */
async function realTurn($: Engine, w: World, n: 1 | 2) {
  const ids = REAL[n]
  const turnId = 't' + n
  await append($, ids.u, 'prompt', 'user', say('test'))
  const u = await user($, zeroed(ids.u))
  await Promise.all([$.turn.start({ text: 'test', turnId } as never), attach($, n)])
  await append($, ids.b, 'response', 'assistant', [...say('Hello'), { type: 'tool_use', id: 'toolu_' + n, name: 'Read', input: {} }])
  const b = await assistant($, zeroed(ids.b))
  const g = await group($, 'collapsed-' + zeroed(ids.b), ['toolu_' + n])
  await Promise.all([$.turn.complete(answerOf(turnId)), append($, ids.d, 'notice', 'system', say('Churned for 4s'), 'turn_duration')])
  const d = await duration($, ids.d, 4000)
  await w.clock.advance(1000)

  return { u, b, g, d }
}

for (const [name, options] of STYLES) {
  const lively = name === 'lively'
  const bars = 0
  const foldedMark = lively ? /[▸▾] #1/ : /▸ #1/

  test(`real row keys (${name}): the prompt has the header, the reply is framed, the duration closes the card`, options, async ($, on) => {
    const w = world(on)
    const { u, b, g, d } = await realTurn($, w, 1)
    expect(await fullText(u)).toBe(cardTop(1) + ENGINE)
    await expectFramed(b, bars)
    await expectFramed(g, bars)
    const drawnD = await d.drawn()
    expect(textOf(drawnD)).toBe(ENGINE + cardBottom)
    expect(sidesOf(drawnD)).toBe(2)
    expect(w.logs).toContain('claudefolder: draw UserMessage b6d78f44 header-open')
    expect(w.logs).toContain('claudefolder: turn.complete 1 header=b6d78f44 closer=714515a1 status=done')
  })

  test(`real row keys (${name}): the next prompt folds the previous turn`, options, async ($, on) => {
    const w = world(on)
    const first = await realTurn($, w, 1)
    const second = await realTurn($, w, 2)
    await w.clock.advance(3000)
    const folded = await fullText(first.u)
    expect(folded).toMatch(foldedMark)
    expect(folded).toContain('#1')
    await expectHidden(first.b)
    await expectHidden(first.g)
    await expectHidden(first.d)
    expect(await fullText(second.u)).toBe(cardTop(2) + ENGINE)
    await expectFramed(second.b, bars)
  })
}
