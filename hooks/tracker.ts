/** One content block of an appended row, as far as the tracker reads it. */
export type Block = { type: string; text?: string; id?: string; tool_use_id?: string }

/**
 * One row `session.append` raised, reduced to what the tracker needs. `name` is the row's `message.name` (a turn-duration
 * notice carries `turn_duration`); `origin` is the `kind` of the append's origin (`peer`, `task-notification`, ...).
 */
export type AppendRow = { uuid: string; door: string; type: string; isMeta: boolean; blocks: Block[]; name?: string; origin?: string }

/** The row an open boxed card closes under: `sticky` for the turn's duration line, which no later row replaces. */
export type Closer = { id: string; sticky: boolean }

/** What started a pending group: a typed prompt, any other starter (a hand-back, a notification, a reminder), or a command row. */
export type PendingKind = 'typed' | 'meta' | 'command'

/** What started a turn: a typed prompt, an agent's message (a hand-back), a notification, or anything else. */
export type StartKind = 'typed' | 'peer' | 'notification' | 'other'

/**
 * The rows appended while idle that wait for the next turn to start: its starter (or command), what came with it, the
 * row it closes under so far, the row that draws its header and, for a starter, its text. `kind` says what started it:
 * later starters join the group, a typed prompt takes the header of a group a meta row started and replaces a group a
 * command started.
 */
export type Pending = {
  kind: PendingKind
  ids: string[]
  header: string | null
  command: string | null
  closer: Closer | null
  text: string | null
  startKind: StartKind
}

/** Which turn the rows being appended belong to. */
export type Tracker = {
  /** The turnId of the main-loop turn that runs now. */
  running: string | null
  /** The turnId of the newest main-loop turn that completed. */
  last: string | null
  /** The requestId of the row that draws the running turn's header, once found. */
  runningHeader: string | null
  pending: Pending | null
  /** By turnId: the row each turn's card closes under. */
  closers: Map<string, Closer>
  /** By turnId: the requestId of the row that draws each turn's header. */
  headers: Map<string, string>
  /** By turnId: the `rowKeyOf` key of every id filed under the turn (at most `MAX_ROW_IDS`), which the saved session keeps. */
  ids: Map<string, string[]>
}

/** The most row keys kept per turn. */
export const MAX_ROW_IDS = 400

export function createTracker(): Tracker {
  return { running: null, last: null, runningHeader: null, pending: null, closers: new Map(), headers: new Map(), ids: new Map() }
}

/**
 * The key a row is filed and looked up under. The engine draws a row under its uuid with the last group (12 hex digits)
 * replaced by zeros, so only a uuid-shaped id is cut to its first four groups; any other id (`toolu_...`) is unchanged.
 * Applied on both sides: to the ids `session.append` carries, and to the `requestId` of a draw.
 */
export function rowKeyOf(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.slice(0, 23) : id
}

/** Adds the keys of `ids` to the ones kept for `turnId`, each once, up to `MAX_ROW_IDS`. Mutates `t`. */
export function rememberIds(t: Tracker, turnId: string, ids: readonly string[]): void {
  const kept = t.ids.get(turnId) ?? []
  const seen = new Set(kept)
  for (const raw of ids) {
    const id = rowKeyOf(raw)
    if (kept.length >= MAX_ROW_IDS) break
    if (!seen.has(id)) {
      seen.add(id)
      kept.push(id)
    }
  }
  t.ids.set(turnId, kept)
}

/** The ids a row can be drawn under: its own uuid, the tool calls it holds and the tool results it answers. */
export function idsOf(row: AppendRow): string[] {
  const ids = [rowKeyOf(row.uuid)]
  for (const b of row.blocks) {
    if (b.type === 'tool_use' && typeof b.id === 'string') ids.push(rowKeyOf(b.id))
    else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.push(rowKeyOf(b.tool_use_id))
  }

  return ids
}

const hasText = (row: AppendRow): boolean => row.blocks.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')

/**
 * True for a row that starts a turn: a user row of the door `prompt` or `delivery` whether or not the person typed it
 * (a hand-back, a task notification and a reminder are meta rows the engine still draws as user messages), or a queued
 * command or teammate message. The engine's door for a queued command is `delivery` (not `attachment`).
 */
export function isStarter(row: AppendRow): boolean {
  if (row.type === 'user' && (row.door === 'prompt' || row.door === 'delivery')) return true

  return row.type === 'attachment' && row.door === 'delivery' && (row.name === 'queued_command' || row.name === 'teammate_mailbox')
}

/** True for a prompt the person typed: a user row of the door `prompt` that is not meta. */
export function isTyped(row: AppendRow): boolean {
  return row.type === 'user' && row.door === 'prompt' && !row.isMeta
}

/** What a starter row says started its turn: a typed prompt, a peer's message, a notification (a delivery attachment or a task notification), else other. */
export function startKindOf(row: AppendRow): StartKind {
  if (isTyped(row)) return 'typed'
  if (row.origin === 'peer' || row.origin === 'peer-send-message') return 'peer'
  if (row.type === 'attachment' || row.origin === 'task-notification') return 'notification'

  return 'other'
}

/**
 * The requestId of the row that draws a turn's header when this row is the first to offer one: a starter its uuid; a
 * command row the person sees its uuid; a response its uuid when it has text, else its first tool call; else null.
 */
export function headerIdOf(row: AppendRow): string | null {
  if (isStarter(row)) return rowKeyOf(row.uuid)
  if (row.door === 'command' && row.type === 'user' && !row.isMeta) return rowKeyOf(row.uuid)
  if (row.door === 'response') {
    if (hasText(row)) return rowKeyOf(row.uuid)
    for (const b of row.blocks) if (b.type === 'tool_use' && typeof b.id === 'string') return rowKeyOf(b.id)
  }

  return null
}

/**
 * The row an open card would close under if this row were the newest of its turn: the duration notice (sticky), the
 * last tool call of a response, a reply's text row, the last tool result, a starter or command row. Null for every other row.
 */
export function closerOf(row: AppendRow): Closer | null {
  if (row.door === 'notice' && row.name === 'turn_duration') return { id: rowKeyOf(row.uuid), sticky: true }
  if (row.door === 'response') {
    const calls = row.blocks.filter(b => b.type === 'tool_use' && typeof b.id === 'string')
    const lastCall = calls[calls.length - 1]
    if (lastCall?.id !== undefined) return { id: rowKeyOf(lastCall.id), sticky: false }
    if (hasText(row)) return { id: rowKeyOf(row.uuid), sticky: false }

    return null
  }
  if (row.door === 'tool-result') {
    const results = row.blocks.filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    const last = results[results.length - 1]

    return last?.tool_use_id === undefined ? null : { id: rowKeyOf(last.tool_use_id), sticky: false }
  }
  if (isStarter(row) || (row.door === 'command' && row.type === 'user' && !row.isMeta)) return { id: rowKeyOf(row.uuid), sticky: false }

  return null
}

/** `current` after a candidate: a sticky closer is kept, otherwise the candidate replaces it. */
function applyCloser(current: Closer | null, candidate: Closer | null): Closer | null {
  if (candidate === null) return current
  if (current !== null && current.sticky) return current

  return candidate
}

/** `/name args` of a command row (`<command-name>` and `<command-args>` tags), or null when the row has no command name. */
export function commandTitleOf(row: AppendRow): string | null {
  const text = row.blocks
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
  const name = /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/.exec(text)?.[1]
  if (name === undefined || name === '') return null
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]

  return '/' + name + (args !== undefined && args.trim() !== '' ? ' ' + args.trim() : '')
}

/** The text blocks of a row joined, or null when it has none. */
function textOf(row: AppendRow): string | null {
  const parts = row.blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text)

  return parts.length === 0 ? null : parts.join('')
}

/**
 * What `onAppend` decided: the ids to file, the turn to file them under and the id of that turn's closer when this row
 * changed it. The header of the running turn lives in `Tracker.headers` until the turn completes.
 */
export type Appended = {
  assign: string[]
  to: string | null
  closer: string | null
}

const NOTHING: Appended = { assign: [], to: null, closer: null }

/** The closer of turn `turnId` after `row`, and its id when the row changed it (else null). */
function moveCloser(t: Tracker, turnId: string, row: AppendRow): string | null {
  const before = t.closers.get(turnId) ?? null
  const after = applyCloser(before, closerOf(row))
  if (after === null) return null
  t.closers.set(turnId, after)

  return after.id !== before?.id ? after.id : null
}

/**
 * Files one appended row. While a turn runs its rows belong to it; while idle a starter (or command) row starts the
 * `pending` group the next turn adopts, and the tail rows after an end (the duration notice, the interrupt notice) belong
 * to the turn that ended, until its duration notice has come. The header is the turn's starter row; a turn that has none
 * takes its first reply (or tool call) instead. Mutates `t`.
 */
export function onAppend(t: Tracker, row: AppendRow): Appended {
  if (row.door === 'queue' || row.door === 'compaction') return { ...NOTHING }
  if (t.running !== null) {
    const ids = idsOf(row)
    const header = headerIdOf(row)
    if (t.runningHeader === null && header !== null) {
      t.runningHeader = header
      t.headers.set(t.running, header)
    }
    rememberIds(t, t.running, ids)

    return { assign: ids, to: t.running, closer: moveCloser(t, t.running, row) }
  }
  if (isStarter(row)) {
    const kind: PendingKind = isTyped(row) ? 'typed' : 'meta'
    const p = t.pending
    if (p === null || (kind === 'typed' && p.kind === 'command')) {
      // A new group; a typed prompt also replaces a group a command started (that group never got a turn).
      t.pending = {
        kind,
        ids: idsOf(row),
        header: rowKeyOf(row.uuid),
        command: null,
        closer: closerOf(row),
        text: textOf(row),
        startKind: startKindOf(row),
      }
    } else if (kind === 'typed' && p.kind === 'meta') {
      // A typed prompt joins a group a meta row started and takes its header, title text and kind.
      p.ids.push(...idsOf(row))
      p.closer = applyCloser(p.closer, closerOf(row))
      p.kind = 'typed'
      p.header = rowKeyOf(row.uuid)
      p.text = textOf(row)
      p.startKind = 'typed'
    } else {
      // Another starter joins the group: its header and title stay.
      p.ids.push(...idsOf(row))
      p.closer = applyCloser(p.closer, closerOf(row))
    }

    return { ...NOTHING }
  }
  if (row.door === 'command') {
    if (t.pending === null) {
      t.pending = {
        kind: 'command',
        ids: idsOf(row),
        header: headerIdOf(row),
        command: commandTitleOf(row),
        closer: closerOf(row),
        text: null,
        startKind: 'other',
      }
    } else {
      t.pending.ids.push(...idsOf(row))
      t.pending.header ??= headerIdOf(row)
      t.pending.command ??= commandTitleOf(row)
      t.pending.closer = applyCloser(t.pending.closer, closerOf(row))
    }

    return { ...NOTHING }
  }
  if (t.pending !== null) {
    t.pending.ids.push(...idsOf(row))
    t.pending.closer = applyCloser(t.pending.closer, closerOf(row))

    return { ...NOTHING }
  }
  if (t.last !== null) {
    // A later duration notice replaces the waiting one; once the duration line has come no other idle row joins the turn.
    const isDuration = row.door === 'notice' && row.name === 'turn_duration'
    if (!isDuration && t.closers.get(t.last)?.sticky === true) return { ...NOTHING }

    const ids = idsOf(row)
    rememberIds(t, t.last, ids)

    return { assign: ids, to: t.last, closer: moveCloser(t, t.last, row) }
  }

  return { ...NOTHING }
}

/** A main-loop turn starts: it adopts the pending rows, their header, kind and text, the command title and the closer so far. Mutates `t`. */
export function onTurnStart(
  t: Tracker,
  turnId: string,
): { assign: string[]; header: string | null; command: string | null; closer: string | null; text: string | null; startKind: StartKind } {
  const pending = t.pending
  const result = {
    assign: pending === null ? [] : [...pending.ids],
    header: pending?.header ?? null,
    command: pending?.command ?? null,
    closer: pending?.closer?.id ?? null,
    text: pending?.text ?? null,
    startKind: pending?.startKind ?? ('other' as StartKind),
  }
  t.running = turnId
  t.runningHeader = result.header
  if (result.header !== null) t.headers.set(turnId, result.header)
  if (pending !== null && pending.closer !== null) t.closers.set(turnId, pending.closer)
  rememberIds(t, turnId, result.assign)
  t.pending = null

  return result
}

/**
 * The newest turn that completed before this load of the module (a reload keeps the turns in the state, a restart restores
 * them): later tail rows may join it, but its card is closed already, so its closer is sticky and an idle row that starts
 * nothing (a notice, a log line) is left unassigned, as after a duration line in the same load. Mutates `t`.
 */
export function resumeLast(t: Tracker, turnId: string, closer: string | null): void {
  t.last = turnId
  if (closer !== null) t.closers.set(turnId, { id: closer, sticky: true })
}

/** A main-loop turn ends: later tail rows belong to it. Mutates `t`. */
export function onTurnComplete(t: Tracker, turnId: string): void {
  t.last = turnId
  if (t.running === turnId) {
    t.running = null
    t.runningHeader = null
  }
}
