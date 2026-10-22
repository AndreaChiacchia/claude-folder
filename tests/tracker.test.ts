import { expect, test } from 'claude-code/testing'

import {
  MAX_ROW_IDS,
  closerOf,
  commandTitleOf,
  createTracker,
  headerIdOf,
  idsOf,
  isStarter,
  onAppend,
  onTurnComplete,
  onTurnStart,
  resumeLast,
  rowKeyOf,
  startKindOf,
} from '../hooks/tracker'
import type { AppendRow, Block } from '../hooks/tracker'

const text = (t: string): Block => ({ type: 'text', text: t })
const call = (id: string): Block => ({ type: 'tool_use', id })
const result = (id: string): Block => ({ type: 'tool_result', tool_use_id: id })

const row = (uuid: string, door: string, type: string, blocks: Block[] = [], isMeta = false, name?: string, origin?: string): AppendRow => ({
  uuid,
  door,
  type,
  isMeta,
  blocks,
  ...(name === undefined ? {} : { name }),
  ...(origin === undefined ? {} : { origin }),
})

const NOTHING = { assign: [], to: null, closer: null }

const plain = (id: string) => ({ id, sticky: false })

test('a prompt waits as pending and the turn that starts adopts its rows and header', () => {
  const t = createTracker()
  expect(onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))).toEqual(NOTHING)
  expect(t.pending).toEqual({ kind: 'typed', ids: ['u1'], header: 'u1', command: null, closer: plain('u1'), text: 'hi', startKind: 'typed' })
  expect(onTurnStart(t, 't1')).toEqual({ assign: ['u1'], header: 'u1', command: null, closer: 'u1', text: 'hi', startKind: 'typed' })
  expect(t.closers.get('t1')).toEqual(plain('u1'))
  expect(t.headers.get('t1')).toBe('u1')
  expect(t.running).toBe('t1')
  expect(t.runningHeader).toBe('u1')
  expect(t.pending).toBeNull()
})

test('the rows of a running turn map their uuid and the tool calls they hold', () => {
  const t = createTracker()
  onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))
  onTurnStart(t, 't1')
  expect(onAppend(t, row('a1', 'response', 'assistant', [text('Ok'), call('toolu_1')]))).toEqual({
    assign: ['a1', 'toolu_1'],
    to: 't1',
    closer: 'toolu_1',
  })
  expect(onAppend(t, row('a2', 'response', 'assistant', [call('toolu_2'), call('toolu_3')])).assign).toEqual([
    'a2',
    'toolu_2',
    'toolu_3',
  ])
  // The starter row stays the header.
  expect(t.headers.get('t1')).toBe('u1')
})

test('a tool result maps its own uuid and the call it answers', () => {
  const t = createTracker()
  onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))
  onTurnStart(t, 't1')
  expect(onAppend(t, row('r1', 'tool-result', 'user', [result('toolu_1')]))).toEqual({
    assign: ['r1', 'toolu_1'],
    to: 't1',
    closer: 'toolu_1',
  })
})

test('a tool-first turn takes its first text reply, else its first call', () => {
  const t = createTracker()
  expect(onTurnStart(t, 't1')).toEqual({ assign: [], header: null, command: null, closer: null, text: null, startKind: 'other' })
  onAppend(t, row('a1', 'response', 'assistant', [call('toolu_9'), call('toolu_10')]))
  expect(t.runningHeader).toBe('toolu_9')
  expect(t.headers.get('t1')).toBe('toolu_9')
  onAppend(t, row('a2', 'response', 'assistant', [text('Done')]))
  expect(t.headers.get('t1')).toBe('toolu_9')

  const t2 = createTracker()
  onTurnStart(t2, 't2')
  onAppend(t2, row('a1', 'response', 'assistant', [text('   '), call('toolu_1')]))
  expect(t2.headers.get('t2')).toBe('toolu_1')
  const t3 = createTracker()
  onTurnStart(t3, 't3')
  onAppend(t3, row('a1', 'response', 'assistant', [text('Hello')]))
  expect(t3.headers.get('t3')).toBe('a1')
})

test("turn.start before the prompt's append: the prompt becomes the running header", () => {
  const t = createTracker()
  onTurnStart(t, 't1')
  expect(t.runningHeader).toBeNull()
  expect(onAppend(t, row('u1', 'prompt', 'user', [text('hi')])).to).toBe('t1')
  expect(t.runningHeader).toBe('u1')
  expect(t.headers.get('t1')).toBe('u1')
  onAppend(t, row('a1', 'response', 'assistant', [text('Hello')]))
  expect(t.headers.get('t1')).toBe('u1')
})

test('two meta starters: the first is the header; a typed prompt after them takes the header and both are adopted', () => {
  const t = createTracker()
  expect(onAppend(t, row('m0', 'prompt', 'user', [text('reminder')], true))).toEqual(NOTHING)
  expect(t.pending).toEqual({ kind: 'meta', ids: ['m0'], header: 'm0', command: null, closer: plain('m0'), text: 'reminder', startKind: 'other' })
  onAppend(t, row('m1', 'delivery', 'user', [text('second')], true))
  expect(t.pending).toMatchObject({ kind: 'meta', ids: ['m0', 'm1'], header: 'm0', text: 'reminder' })
  onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))
  expect(t.pending).toMatchObject({ kind: 'typed', ids: ['m0', 'm1', 'u1'], header: 'u1', text: 'hi', startKind: 'typed' })
  const start = onTurnStart(t, 't1')
  expect(start).toMatchObject({ assign: ['m0', 'm1', 'u1'], header: 'u1', startKind: 'typed' })
  expect(headerIdOf(row('m2', 'delivery', 'user', [text('x')], true))).toBe('m2')
})

test('rows after the end of a turn belong to it', () => {
  const t = createTracker()
  onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))
  onTurnStart(t, 't1')
  onTurnComplete(t, 't1')
  expect(t.running).toBeNull()
  expect(t.last).toBe('t1')
  expect(onAppend(t, row('n1', 'notice', 'system', [text('Baked for 3s')]))).toEqual({
    assign: ['n1'],
    to: 't1',
    closer: null,
  })
  // A prompt that follows waits for the next turn instead.
  expect(onAppend(t, row('u2', 'prompt', 'user', [text('again')]))).toEqual(NOTHING)
  expect(onAppend(t, row('att', 'attachment', 'attachment', []))).toEqual(NOTHING)
  expect(t.pending?.ids).toEqual(['u2', 'att'])
})

test('a local command and then a prompt: the prompt replaces the command group', () => {
  const t = createTracker()
  const cmd = row('c1', 'command', 'user', [text('<command-name>/cost</command-name><command-args></command-args>')])
  expect(onAppend(t, cmd)).toEqual(NOTHING)
  expect(t.pending).toEqual({ kind: 'command', ids: ['c1'], header: 'c1', command: '/cost', closer: plain('c1'), text: null, startKind: 'other' })
  onAppend(t, row('u2', 'prompt', 'user', [text('hello')]))
  expect(t.pending).toEqual({ kind: 'typed', ids: ['u2'], header: 'u2', command: null, closer: plain('u2'), text: 'hello', startKind: 'typed' })
  expect(onTurnStart(t, 't2').command).toBeNull()
})

test('a command group a turn adopts gives the command title', () => {
  const t = createTracker()
  onAppend(t, row('c1', 'command', 'user', [text('<command-name>/compact</command-name><command-args>now please</command-args>')]))
  onAppend(t, row('c2', 'command', 'user', [text('<local-command-stdout>done</local-command-stdout>')]))
  onAppend(t, row('c3', 'note', 'system', [text('x')]))
  expect(t.pending).toEqual({
    kind: 'command',
    ids: ['c1', 'c2', 'c3'],
    header: 'c1',
    command: '/compact now please',
    closer: plain('c2'),
    text: null,
    startKind: 'other',
  })
  expect(onTurnStart(t, 't1')).toEqual({
    assign: ['c1', 'c2', 'c3'],
    header: 'c1',
    command: '/compact now please',
    closer: 'c2',
    text: null,
    startKind: 'other',
  })
})

test('compaction and queue rows are ignored, idle or running', () => {
  const t = createTracker()
  expect(onAppend(t, row('q1', 'queue', 'user', [text('typed ahead')]))).toEqual(NOTHING)
  expect(onAppend(t, row('k1', 'compaction', 'user', [text('summary')]))).toEqual(NOTHING)
  expect(t.pending).toBeNull()
  onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))
  onTurnStart(t, 't1')
  expect(onAppend(t, row('q2', 'queue', 'user', [text('more')]))).toEqual(NOTHING)
  expect(onAppend(t, row('k2', 'compaction', 'user', [text('summary')]))).toEqual(NOTHING)
})

test('idsOf takes the uuid, the tool calls and the tool results, strings only', () => {
  const r = row('a1', 'response', 'assistant', [call('toolu_1'), result('toolu_0'), { type: 'tool_use' }, { type: 'text', text: 'x' }])
  expect(idsOf(r)).toEqual(['a1', 'toolu_1', 'toolu_0'])
})

test('commandTitleOf reads the command name and its arguments', () => {
  const of = (s: string) => commandTitleOf(row('c', 'command', 'user', [text(s)]))
  expect(of('<command-name>/foo</command-name><command-args>a b</command-args>')).toBe('/foo a b')
  expect(of('<command-name>foo</command-name>')).toBe('/foo')
  expect(of('<command-name> /foo </command-name><command-args>  </command-args>')).toBe('/foo')
  expect(of('<local-command-stdout>x</local-command-stdout>')).toBeNull()
})

test('headerIdOf: the starter rows have their own row, a response gives its text row or its first call', () => {
  expect(headerIdOf(row('u1', 'prompt', 'user', [text('hi')]))).toBe('u1')
  expect(headerIdOf(row('u1', 'command', 'user', [text('x')]))).toBe('u1')
  expect(headerIdOf(row('u1', 'command', 'user', [text('x')], true))).toBeNull()
  expect(headerIdOf(row('a1', 'response', 'assistant', [text('Hi')]))).toBe('a1')
  expect(headerIdOf(row('a1', 'response', 'assistant', [text(' '), call('toolu_1')]))).toBe('toolu_1')
  expect(headerIdOf(row('a1', 'response', 'assistant', []))).toBeNull()
  expect(headerIdOf(row('r1', 'tool-result', 'user', [result('toolu_1')]))).toBeNull()
  expect(headerIdOf(row('n1', 'notice', 'system', [text('x')]))).toBeNull()
  expect(headerIdOf(row('d1', 'notice', 'system', [], false, 'turn_duration'))).toBeNull()
})

test('closerOf: the duration notice is sticky, a reply its text row or its last call, a result its call, a starter itself', () => {
  expect(closerOf(row('d1', 'notice', 'system', [text('Baked for 3s')], false, 'turn_duration'))).toEqual({ id: 'd1', sticky: true })
  expect(closerOf(row('a1', 'response', 'assistant', [text('Hi')]))).toEqual(plain('a1'))
  expect(closerOf(row('a2', 'response', 'assistant', [text('Hi'), call('toolu_1'), call('toolu_2')]))).toEqual(plain('toolu_2'))
  expect(closerOf(row('r1', 'tool-result', 'user', [result('toolu_1'), result('toolu_2')]))).toEqual(plain('toolu_2'))
  expect(closerOf(row('u1', 'prompt', 'user', [text('hi')]))).toEqual(plain('u1'))
  expect(closerOf(row('m1', 'prompt', 'user', [text('reminder')], true))).toEqual(plain('m1'))
  expect(closerOf(row('m2', 'delivery', 'user', [text('Message from an agent')], true))).toEqual(plain('m2'))
  expect(closerOf(row('att', 'attachment', 'attachment', []))).toBeNull()
  expect(closerOf(row('q', 'delivery', 'attachment', [], false, 'queued_command'))).toEqual(plain('q'))
  expect(closerOf(row('n1', 'notice', 'system', [text('x')]))).toBeNull()
  expect(closerOf(row('a3', 'response', 'assistant', [text('  ')]))).toBeNull()
})

test('the closer of a turn follows its newest drawn row and settles on the duration line', () => {
  const t = createTracker()
  expect(onAppend(t, row('u', 'prompt', 'user', [text('hi')]))).toEqual(NOTHING)
  expect(onTurnStart(t, 't1').closer).toBe('u')
  expect(t.closers.get('t1')).toEqual(plain('u'))
  expect(onAppend(t, row('a', 'response', 'assistant', [call('toolu_1')])).closer).toBe('toolu_1')
  expect(t.closers.get('t1')).toEqual(plain('toolu_1'))
  expect(onAppend(t, row('r', 'tool-result', 'user', [result('toolu_1')])).closer).toBeNull()
  expect(t.closers.get('t1')).toEqual(plain('toolu_1'))
  expect(onAppend(t, row('b', 'response', 'assistant', [text('Done')])).closer).toBe('b')
  onTurnComplete(t, 't1')
  expect(onAppend(t, row('d', 'notice', 'system', [text('Baked for 3s')], false, 'turn_duration'))).toEqual({
    assign: ['d'],
    to: 't1',
    closer: 'd',
  })
  expect(t.closers.get('t1')).toEqual({ id: 'd', sticky: true })
  expect(onAppend(t, row('n', 'notice', 'system', [text('x')])).closer).toBeNull()
  // A sticky closer is kept, even against a later row that would otherwise move it.
  expect(onAppend(t, row('b2', 'response', 'assistant', [text('Late')])).closer).toBeNull()
  expect(t.closers.get('t1')).toEqual({ id: 'd', sticky: true })
})

// ---- starters and kinds --------------------------------------------------------------------

test('isStarter: a prompt or a delivery user row whatever its meta flag, and a queued command or a teammate message delivery', () => {
  expect(isStarter(row('a', 'prompt', 'user', [text('x')], true))).toBe(true)
  expect(isStarter(row('b', 'delivery', 'user', [text('x')], true))).toBe(true)
  expect(isStarter(row('c', 'prompt', 'user', [text('x')]))).toBe(true)
  // The engine's door for a queued command is `delivery`; an attachment row of the door `attachment` starts nothing.
  expect(isStarter(row('d', 'delivery', 'attachment', [], false, 'queued_command'))).toBe(true)
  expect(isStarter(row('d2', 'attachment', 'attachment', [], false, 'queued_command'))).toBe(false)
  expect(isStarter(row('d3', 'delivery', 'attachment', [], false, 'teammate_mailbox'))).toBe(true)
  expect(isStarter(row('d4', 'delivery', 'attachment', [], false, 'poll_events'))).toBe(false)
  expect(isStarter(row('e', 'command', 'user', [text('x')]))).toBe(false)
  expect(isStarter(row('f', 'attachment', 'attachment', []))).toBe(false)
  expect(isStarter(row('g', 'notice', 'system', [text('x')]))).toBe(false)
})

test('startKindOf: typed, peer, notification (an attachment or a task notification) or other', () => {
  expect(startKindOf(row('a', 'prompt', 'user', [text('x')], false, undefined, 'composer'))).toBe('typed')
  expect(startKindOf(row('b', 'prompt', 'user', [text('x')], true, undefined, 'peer'))).toBe('peer')
  expect(startKindOf(row('c', 'prompt', 'user', [text('x')], true, undefined, 'peer-send-message'))).toBe('peer')
  expect(startKindOf(row('d', 'prompt', 'user', [text('x')], true, undefined, 'task-notification'))).toBe('notification')
  expect(startKindOf(row('e', 'delivery', 'attachment', [], false, 'queued_command'))).toBe('notification')
  expect(startKindOf(row('f', 'delivery', 'user', [text('x')], true))).toBe('other')
})

test('a hand-back turn adopts its peer row as the header, and later rows do not take it', () => {
  const t = createTracker()
  expect(onAppend(t, row('m', 'prompt', 'user', [text('Message from @general-purpose')], true, undefined, 'peer'))).toEqual(NOTHING)
  const start = onTurnStart(t, 't2')
  expect(start.assign).toEqual(['m'])
  expect(start.header).toBe('m')
  expect(start.startKind).toBe('peer')
  expect(start.text).toBe('Message from @general-purpose')
  onAppend(t, row('a', 'response', 'assistant', [call('x1'), call('x2')]))
  onAppend(t, row('b', 'response', 'assistant', [text('Checks pass.')]))
  onTurnComplete(t, 't2')
  onAppend(t, row('d', 'notice', 'system', [text('Baked')], false, 'turn_duration'))
  expect(t.headers.get('t2')).toBe('m')
})

test('after the duration line an idle row that starts nothing is left unassigned, but a later duration line still joins', () => {
  const t = createTracker()
  onAppend(t, row('u', 'prompt', 'user', [text('hi')]))
  onTurnStart(t, 't1')
  onTurnComplete(t, 't1')
  expect(onAppend(t, row('d', 'notice', 'system', [], false, 'turn_duration')).to).toBe('t1')
  expect(onAppend(t, row('n', 'notice', 'system', [text('x')]))).toEqual(NOTHING)
  expect(onAppend(t, row('att', 'attachment', 'attachment', []))).toEqual(NOTHING)
  const again = onAppend(t, row('d2', 'notice', 'system', [], false, 'turn_duration'))
  expect(again.to).toBe('t1')
  expect(again.assign).toEqual(['d2'])
})

test('a turn that completed before this load: its closer is sticky, so a log line the reload appends is left unassigned', () => {
  const t = createTracker()
  resumeLast(t, 't1', 'd')
  expect(t.last).toBe('t1')
  expect(t.closers.get('t1')).toEqual({ id: 'd', sticky: true })
  expect(onAppend(t, row('n', 'notice', 'system', [text('claudefolder: options changed')], false, 'informational'))).toEqual(NOTHING)
  expect(onAppend(t, row('att', 'attachment', 'attachment', []))).toEqual(NOTHING)
  // A later duration line still joins, and a prompt still starts the next group.
  expect(onAppend(t, row('d2', 'notice', 'system', [], false, 'turn_duration')).to).toBe('t1')
  expect(onAppend(t, row('u2', 'prompt', 'user', [text('next')]))).toEqual(NOTHING)
  expect(onTurnStart(t, 't2').assign).toEqual(['u2'])
  // A turn saved with no closer keeps the tail rule it had: its rows join until a duration line comes.
  const u = createTracker()
  resumeLast(u, 't1', null)
  expect(onAppend(u, row('n', 'notice', 'system', [text('x')])).to).toBe('t1')
})

test('a queued command attachment (door delivery) starts a turn too', () => {
  const t = createTracker()
  expect(onAppend(t, row('q', 'delivery', 'attachment', [text('do this next')], false, 'queued_command'))).toEqual(NOTHING)
  expect(t.pending).toMatchObject({ kind: 'meta', ids: ['q'], header: 'q', text: 'do this next', startKind: 'notification' })
  const start = onTurnStart(t, 't1')
  expect(start).toMatchObject({ assign: ['q'], header: 'q', startKind: 'notification' })
  expect(t.runningHeader).toBe('q')
})

// ---- starters join, rows are filed in order ---------------------------------------------------

test('a meta row between a typed prompt and its turn joins the group: the turn adopts both, the prompt stays the header', () => {
  const t = createTracker()
  onAppend(t, row('u', 'prompt', 'user', [text('test')]))
  expect(onAppend(t, row('m', 'prompt', 'user', [text('reminder')], true))).toEqual(NOTHING)
  expect(t.pending).toMatchObject({ kind: 'typed', ids: ['u', 'm'], header: 'u', text: 'test' })
  const start = onTurnStart(t, 't1')
  expect(start.assign).toEqual(['u', 'm'])
  expect(start.header).toBe('u')
  expect(t.runningHeader).toBe('u')
})

test('a typed prompt replaces a group a command started, as built', () => {
  const t = createTracker()
  onAppend(t, row('c1', 'command', 'user', [text('<command-name>/cost</command-name>')]))
  expect(t.pending?.kind).toBe('command')
  onAppend(t, row('u', 'prompt', 'user', [text('hello')]))
  expect(t.pending).toMatchObject({ kind: 'typed', ids: ['u'], header: 'u', command: null })
})

test('a typed prompt joins a group a meta row started and takes the header: the meta row is adopted', () => {
  const t = createTracker()
  onAppend(t, row('m', 'delivery', 'user', [text('Message from @agent')], true, undefined, 'peer'))
  expect(t.pending?.kind).toBe('meta')
  expect(t.pending?.startKind).toBe('peer')
  onAppend(t, row('u', 'prompt', 'user', [text('hello')]))
  const start = onTurnStart(t, 't1')
  expect(start.header).toBe('u')
  expect(start.assign).toEqual(['m', 'u'])
  expect(start.startKind).toBe('typed')
  expect(start.text).toBe('hello')
})

test('two meta starters in one idle gap: the second joins, the header is the first', () => {
  const t = createTracker()
  onAppend(t, row('m1', 'delivery', 'user', [text('first')], true))
  onAppend(t, row('m2', 'delivery', 'user', [text('second')], true))
  expect(t.pending).toMatchObject({ kind: 'meta', ids: ['m1', 'm2'], header: 'm1', text: 'first' })
  expect(onTurnStart(t, 't1').header).toBe('m1')
})

const ATTACHMENTS = ['environment', 'deferred_tools_delta', 'mcp_instructions_delta', 'total_tokens_reminder', 'deferred_tools_record']
const attachment = (i: number): AppendRow => row('att' + i, 'attachment', 'attachment', [], false, ATTACHMENTS[i])

test('the live sequence: every row of the turn is filed under it, the header is the prompt and the duration line closes it', () => {
  const t = createTracker()
  onAppend(t, row('u', 'prompt', 'user', [text('test')]))
  expect(onTurnStart(t, 't1')).toMatchObject({ assign: ['u'], header: 'u' })
  for (let i = 0; i < ATTACHMENTS.length; i++) expect(onAppend(t, attachment(i)).to).toBe('t1')
  expect(onAppend(t, row('b', 'response', 'assistant', [text('Hello')])).to).toBe('t1')
  onTurnComplete(t, 't1')
  const d = onAppend(t, row('d', 'notice', 'system', [text('Churned for 4s')], false, 'turn_duration'))
  expect(d.to).toBe('t1')
  expect(d.closer).toBe('d')
  expect(t.runningHeader).toBeNull()
  expect(t.headers.get('t1')).toBe('u')
  expect(t.closers.get('t1')).toEqual({ id: 'd', sticky: true })
})

test('the same with the attachments appended before the prompt while idle: they are unassigned', () => {
  const t = createTracker()
  for (let i = 0; i < ATTACHMENTS.length; i++) expect(onAppend(t, attachment(i))).toEqual(NOTHING)
  onAppend(t, row('u', 'prompt', 'user', [text('test')]))
  expect(onTurnStart(t, 't1')).toMatchObject({ assign: ['u'], header: 'u' })
  onAppend(t, row('b', 'response', 'assistant', [text('Hello')]))
  onTurnComplete(t, 't1')
  expect(onAppend(t, row('d', 'notice', 'system', [text('Churned for 4s')], false, 'turn_duration')).assign).toEqual(['d'])
  expect(t.headers.get('t1')).toBe('u')
})

test('the live sequence of a notification turn: the delivery attachment starts it, the header is that row', () => {
  const t = createTracker()
  onAppend(t, row('n', 'delivery', 'attachment', [text('Agent "build" finished')], false, 'queued_command'))
  expect(onTurnStart(t, 't1')).toMatchObject({ assign: ['n'], header: 'n', startKind: 'notification' })
  for (let i = 0; i < ATTACHMENTS.length; i++) expect(onAppend(t, attachment(i)).to).toBe('t1')
  onAppend(t, row('b', 'response', 'assistant', [text('Noted.')]))
  onTurnComplete(t, 't1')
  expect(onAppend(t, row('d', 'notice', 'system', [text('Baked for 2s')], false, 'turn_duration')).to).toBe('t1')
  expect(t.headers.get('t1')).toBe('n')
})

test('rowKeyOf: a uuid is cut to its first four groups', () => {
  expect(rowKeyOf('b6d78f44-8266-4aaa-84e5-0041bd1ce1bd')).toBe('b6d78f44-8266-4aaa-84e5')
})

test('rowKeyOf: a uuid and the engine key with its last group zeroed give the same key', () => {
  expect(rowKeyOf('b6d78f44-8266-4aaa-84e5-000000000000')).toBe(rowKeyOf('b6d78f44-8266-4aaa-84e5-0041bd1ce1bd'))
})

test('rowKeyOf: other ids are unchanged, and a key is stable', () => {
  expect(rowKeyOf('toolu_01ABC')).toBe('toolu_01ABC')
  expect(rowKeyOf('u1')).toBe('u1')
  expect(rowKeyOf('collapsed-a7915ca1-3543-4154-ba44-000000000000')).toBe('collapsed-a7915ca1-3543-4154-ba44-000000000000')
  expect(rowKeyOf(rowKeyOf('b6d78f44-8266-4aaa-84e5-0041bd1ce1bd'))).toBe('b6d78f44-8266-4aaa-84e5')
})

test('rowKeyOf: the tracker files a row under its key', () => {
  const t = createTracker()
  onAppend(t, { uuid: 'b6d78f44-8266-4aaa-84e5-0041bd1ce1bd', door: 'prompt', type: 'user', isMeta: false, blocks: [{ type: 'text', text: 'hi' }] })
  const res = onTurnStart(t, 't1')
  expect(res.assign).toEqual(['b6d78f44-8266-4aaa-84e5'])
  expect(res.header).toBe('b6d78f44-8266-4aaa-84e5')
})

test('the tracker keeps the row keys of each turn: adopted, running and tail rows, each once', () => {
  const t = createTracker()
  onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))
  onTurnStart(t, 't1')
  expect(t.ids.get('t1')).toEqual(['u1'])
  onAppend(t, row('a1', 'response', 'assistant', [text('Ok'), call('toolu_1')]))
  onAppend(t, row('r1', 'tool-result', 'user', [result('toolu_1')]))
  expect(t.ids.get('t1')).toEqual(['u1', 'a1', 'toolu_1', 'r1'])
  onTurnComplete(t, 't1')
  onAppend(t, row('d1', 'notice', 'system', [], false, 'turn_duration'))
  expect(t.ids.get('t1')).toEqual(['u1', 'a1', 'toolu_1', 'r1', 'd1'])
  // Keys are the engine's: a uuid is cut to its first four groups.
  onAppend(t, row('b6d78f44-8266-4aaa-84e5-0041bd1ce1bd', 'prompt', 'user', [text('again')]))
  onTurnStart(t, 't2')
  expect(t.ids.get('t2')).toEqual(['b6d78f44-8266-4aaa-84e5'])
})

test('the row keys kept per turn stop at 400', () => {
  const t = createTracker()
  onAppend(t, row('u1', 'prompt', 'user', [text('hi')]))
  onTurnStart(t, 't1')
  for (let i = 0; i < 500; i++) onAppend(t, row('x' + i, 'response', 'assistant', [text('more')]))
  expect(t.ids.get('t1')!.length).toBe(MAX_ROW_IDS)
  expect(t.ids.get('t1')![0]).toBe('u1')
})
