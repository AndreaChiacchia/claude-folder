import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Edge, FoldFx, FolderHeadProps, FolderStatus, FolderTurn, SavedSession, SavedTurn, Settings } from '../types'
import { BOX, EDGES, GOLD, MARKERS, PALETTES, hex, packCells, paletteFor, runsAll } from './cells'
import type { Cell, HeadCell, Palette } from './cells'
import { buildHeader, cardBottom, outlineOf } from './header'
import type { HeaderModel } from './header'
import { FOLD_DELAY_MS, FRAME_MS, LEVELS, composeRows, composeText, createMotion, lineCells, textRuns } from './motion'
import type { TextCell } from './motion'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'
import { fileOf, notificationTitleOf, replyOf, stripTags, titleOf } from './summary'
import { MAX_ROW_IDS, createTracker, onAgentLaunched, onAppend, onTurnComplete, onTurnStart, resumeLast, rowKeyOf } from './tracker'
import type { Appended, AppendRow, Block, Tracker } from './tracker'

/** The width assumed when the surface has not measured. */
const DEFAULT_COLUMNS = 80
/** A turn number's hover group and Button keys: never another mod's. */
const SCOPE_PREFIX = 'claudefolder-'
const KEY_PREFIX = 'fold-'
/** The key of a turn's header Client: `ui.message` names it. */
const HEAD_PREFIX = 'folder-head-'
/** The header's surface module, as its `Client` and the fault hook name it. */
const HEAD_MODULE = 'headerClient.tsx'
/** The lines of the edge bar that runs down an open turn's row: more than any row is tall, clipped to the row. */
const RAIL_LINES = 400
/** A fold or an unfold this recent (ms) is drawn by the header module as an effect. */
const FX_WINDOW_MS = 2000
/** A change is saved to the store this long after the first one (ms): a burst of writes makes one save. */
const SAVE_DELAY_MS = 1500
/** A row filed while a turn runs is saved this long after (ms): a reload in the middle of a turn loses at most this much. */
const RUNNING_SAVE_DELAY_MS = 10_000
/** The most JSON characters one saved session takes: eight of them stay well under the store's 4 MiB. */
const SESSION_BUDGET = 400_000
/** When the store refuses a save, the other sessions kept (each within the budget) before the one retry. */
const RETRY_KEEP_SESSIONS = 2
/** The most rows the in-memory row map holds; past it, it starts again and draws read the row members instead. */
const MAX_KNOWN_ROWS = 50_000
/** The most turns of one session, and the most sessions, the store keeps. */
const MAX_SAVED_TURNS = 200
const MAX_SAVED_SESSIONS = 8
/** A session's key in the store: `session:<sessionId>`. */
const SAVE_PREFIX = 'session:'
/** The statuses a saved turn may hold. */
const STATUSES: readonly string[] = ['running', 'done', 'interrupted', 'error']
const START_KINDS: readonly string[] = ['typed', 'peer', 'notification', 'other']

const MAIN_SCREEN_TEXT =
  'Claude-Folder folds turns in the fullscreen view only. Turn it on with "tui": "fullscreen" in your settings, or CLAUDE_CODE_NO_FLICKER=1.'
const USAGE_TEXT =
  'Usage: /folder (toggle all) · /folder open [<n> | last | all] · /folder close [<n> | last | all]'

/** The mod's state references are written inline at each call: the plugin and key stay literals in source; only the id is computed. */
const order = atom({ plugin: 'claudefolder', key: 'order' } as const, [])
/** The background agents the tracker follows (`Tracker.agents`, `Tracker.lastPending`), so a reload goes on counting them. */
const agentsAtom = atom({ plugin: 'claudefolder', key: 'agents' } as const, { pending: [], last: 0 })

/** The /config settings, read in `register`: a module variable, so /clear and /resume keep them; a /config change reloads the module. */
let settings: Settings = DEFAULT_SETTINGS
/** The colors of the terminal's theme, read once in `session.start`; the dark set until then and when the read fails. */
let palette: Palette = PALETTES.dark
/** The edge bar's text by edge glyph: the glyph on `RAIL_LINES` lines. */
const railTexts = new Map<Edge, string>()
/** The card's side bar text: `│` on `RAIL_LINES` lines. */
let cardEdgeText: string | null = null

// State of the running module. It is lost on a reload by design: the next render rebuilds it.
// `register` resets it, so a module instance shared by several loads starts each one clean.
let tracker: Tracker = createTracker()
/** The header's cells at rest come from `composeRows` and `composeText` at level `off`, which read no motion state. */
const restMotion = createMotion()
/** What the main loop did in each turn so far: tool calls and edited files, written to the turn when it completes. */
const counters = new Map<string, { tools: number; files: string[] }>()
/** The timers that fold a turn a moment after it ends (`foldWhen: finish`). */
const foldTimers = new Map<string, Timer>()
/** True while the last row drawn that carries the flag was drawn in full (ctrl+o, --verbose): rows without the flag follow it. */
let lastExpandedView = false
/** The turns whose header row has drawn in this load: only their other rows may hide when folded. */
const headerSeen = new Set<string>()
/** The folded turns a row drew open for because their header had not drawn yet: the header's draw asks one redraw to hide them. */
const unseenDrawn = new Set<string>()
/** True while a redraw of every row waits for its timer: a burst of asks makes one. */
let redrawPending = false
/** The turn each row was filed under in this load, by `rowKeyOf` key: the same value the row member holds, known with no state read. */
const rowTurn = new Map<string, string>()
/** The keys filed under two different turns: never answered from memory (their draws read the row member). */
const movedRows = new Set<string>()
/** The turns that completed in this load and have not folded by the `next` rule yet. */
const foldCandidates = new Set<string>()
/** True until the first turn.start of this load (or session) has looked at every earlier turn for the `next` rule. */
let foldScanNeeded = true
/** Each header's model and Client props at rest, with the key they were built for (the turn, its title, the columns). */
const headCache = new Map<string, { key: string; model: HeaderModel; props: FolderHeadProps }>()
/** The `changedAt` each turn's header last drew with, and whether a change since is still to be drawn as an effect (a header met for the first time is not animated). */
const headerChange = new Map<string, { changedAt: number; animate: boolean }>()
/** The last draw outcome logged per requestId (debug lines only). */
const lastOutcome = new Map<string, string>()
/** Set when the header's surface module fails: every header is drawn as plain Text with Buttons over its text, and no outline light. */
let clientFailed = false
/** The number the next turn gets. */
let nextN = 1
/** True once this load has read the state it continues from (numbering, a running turn, the theme); see `ensureRecovered`. */
let recovered = false
/** The recovery in flight, so hooks that start meanwhile wait for the same one. */
let recovery: Promise<void> | null = null
/** The numbers of the turns this load knows, by turnId: only for the debug lines. */
const turnNumbers = new Map<string, number>()
/** The rows of the turns restored from the store, by `rowKeyOf` key to turnId: the draw reads it when a row has no member (no thousands of state writes). */
const restoredRows = new Map<string, string>()
/** The save waiting for its timer, and the delay it was asked with. */
let saveTimer: Timer | null = null
let saveDelay = 0
/** True once this process has pruned the older sessions from the store. */
let pruned = false

/** The props the render hook reads of a row, whichever component it is. */
type RowProps = {
  isExpanded?: boolean
  onScreen?: { first: number; last: number; of: number } | null
  calls?: ReadonlyArray<{ tool_use_id?: string }>
  from?: { name?: string }
  task?: unknown
  text?: string
}

/** True when this load has seen the turn's header change fold state since it first drew it: only such a change is drawn as an effect. */
function seesChange(turn: FolderTurn): boolean {
  const seen = headerChange.get(turn.turnId)
  if (seen === undefined) {
    headerChange.set(turn.turnId, { changedAt: turn.changedAt, animate: false })

    return false
  }
  if (seen.changedAt !== turn.changedAt) {
    seen.changedAt = turn.changedAt
    seen.animate = true
  }

  return seen.animate
}

/**
 * The fold effect a header's module draws on its own clock: set while the turn's fold or unfold is recent. It carries the
 * marker's glyphs (the state now, and the one it flips from) and the flash's strength; the header's cells stay at rest, and
 * the module sends one lap of its outline light round on top of the marker's flip.
 */
function foldFx(turn: FolderTurn, model: HeaderModel, now: number): FoldFx | undefined {
  const level = settings.motion
  const age = now - turn.changedAt
  if (level === 'off' || turn.changedAt <= 0 || age < 0 || age >= FX_WINDOW_MS) return undefined
  const L = LEVELS[level]
  const glyphs = MARKERS[settings.marker]
  const folded = { cp: glyphs.folded, fg: palette.marker }
  const open = { cp: glyphs.open, fg: palette.markerOpen }
  const rest = turn.folded ? folded : open
  const other = turn.folded ? open : folded

  return {
    kind: turn.folded ? 'fold' : 'unfold',
    age,
    marker: [model.marker.row, model.marker.col, rest.cp, rest.fg, other.cp, other.fg],
    flash: L.flash,
    gold: GOLD,
  }
}

/** Marks a header's fold or unfold effect as over: its later draws read no clock until the turn changes again. */
function settleChange(turnId: string): void {
  const seen = headerChange.get(turnId)
  if (seen !== undefined) seen.animate = false
}

/**
 * A header's model and its Client props at rest. Kept per turn and built again only when the turn, its title or the
 * columns change (the settings and the palette change only with a load, which clears the cache).
 */
function headRest(turn: FolderTurn, title: string, columns: number): { model: HeaderModel; props: FolderHeadProps } {
  const key = JSON.stringify([turn, title, columns])
  const cached = headCache.get(turn.turnId)
  if (cached !== undefined && cached.key === key) return cached
  const model = buildHeader({
    turn: { ...turn, title },
    style: settings.style,
    lines: settings.lines,
    marker: settings.marker,
    edge: settings.edge,
    palette,
    columns,
    folded: turn.folded,
  })
  const rows: Cell[][] = composeRows(restMotion, turn.turnId, model, settings.marker, palette, 'off')
  const texts = composeText(restMotion, turn.turnId, model, palette, 'off')
  const outline = outlineOf(model)
  const props: FolderHeadProps = {
    kind: 'head',
    turnId: turn.turnId,
    rows: model.rows.map((row, r) =>
      packCells(
        lineCells(rows, texts, model, r).map((c): HeadCell => {
          // Flag 4 marks the cells of the text region.
          const region = row.text
          const isText = region !== null && c.col >= region.col && c.col < region.col + region.width

          return [c.col, c.text, c.fg ?? -1, c.bg ?? -1, (c.bold ? 1 : 0) | (c.dim ? 2 : 0) | (isText ? 4 : 0)]
        }),
      ),
    ),
    press: model.rows.flatMap((row, r): [number, number, number, number][] =>
      row.press === null || row.text === null ? [] : [[r, row.press.col, row.press.width, row.text.line === 1 ? 0 : 1]],
    ),
    outline: outline.path,
    cyclic: outline.cyclic,
    level: settings.motion,
    glint: palette.glint,
    tint: [palette.hoverTitle, palette.hoverReply],
  }
  if (headCache.size >= 500) headCache.clear()
  const entry = { key, model, props }
  headCache.set(turn.turnId, entry)

  return entry
}

/** A glyph on every one of `RAIL_LINES` lines. */
function linesOf(cp: number): string {
  return Array.from({ length: RAIL_LINES }, () => String.fromCodePoint(cp)).join('\n')
}

/** The edge bar's text: its glyph on every one of `RAIL_LINES` lines. */
function railText(edge: Edge): string {
  const cached = railTexts.get(edge)
  if (cached !== undefined) return cached
  const text = linesOf(EDGES[edge])
  railTexts.set(edge, text)

  return text
}

/** The card's side bar text: `│` on every one of `RAIL_LINES` lines. */
function edgeText(): string {
  cardEdgeText ??= linesOf(BOX.v)

  return cardEdgeText
}

/**
 * Where the side bars (or the rail bar) of a row's framed part start, in rows from that part's top, or null to draw none.
 * `onScreen` is the row's own report: its rows scrolled away above the viewport (`first`) and its whole height (`of`), its
 * tree's rows counted; `before` is how many rows of the tree come above the framed part (an open header's lines), `after`
 * how many below it (the card's bottom border). The engine draws an absolutely placed Box whose top would be above the
 * screen at the screen's top row with its full height, so a bar that began above the screen would run past its row onto
 * the rows below: started at the first row on screen, it never does. Not reported yet (the first draw): from the top, as
 * the engine reports the row right after; drawn outside the viewport: none.
 */
function barStart(onScreen: RowProps['onScreen'], before: number, after: number): number | null {
  if (onScreen === undefined) return 0
  if (onScreen === null) return null
  if (typeof onScreen.first !== 'number' || !Number.isFinite(onScreen.first)) return 0
  const top = Math.max(0, Math.floor(onScreen.first) - before)
  if (typeof onScreen.of === 'number' && Number.isFinite(onScreen.of) && top >= onScreen.of - before - after) return null

  return top
}

/** Thrown inside `update` to write nothing: the turn is unknown, or the change leaves it as it is. */
const NO_CHANGE = new Error('claudefolder: no change')

/**
 * Changes a turn with `change`, decided from the value at write time; `change` returns null to leave it as it is. Writes
 * nothing for an unknown turn or a null change (every write draws the turn's rows again). Returns whether it wrote.
 */
async function changeTurn($: EngineInterface, id: string, change: (t: FolderTurn) => FolderTurn | null): Promise<boolean> {
  try {
    await update($, { plugin: 'claudefolder', key: 'turn', id } as const, t => {
      const next = t === undefined ? null : change(t)
      if (next === null) throw NO_CHANGE

      return next
    })

    return true
  } catch (err) {
    if (err === NO_CHANGE || (err instanceof Error && err.message === NO_CHANGE.message)) return false
    throw err
  }
}

/** Folds or unfolds a finished turn by the user's choice, deciding from the value at write time; a running or unknown turn is left alone. */
async function toggle($: EngineInterface, turnId: string): Promise<void> {
  const now = await $.clock.now()
  const changed = await changeTurn($, turnId, t => (t.status === 'running' ? null : { ...t, folded: !t.folded, autoFolded: true, changedAt: now }))
  if (!changed) return
  // The rows read the turn while drawing: this write draws them again (no invalidate).
  foldCandidates.delete(turnId)
  $.ui.log(`claudefolder: toggle ${turnNumbers.get(turnId) ?? '?'}`, { to: 'debug' })
  scheduleSave($)
}

/** Writes the fold state of a finished turn, by the user's choice; a turn already in that state by a choice is left alone. */
async function setFolded($: EngineInterface, turnId: string, folded: boolean, now: number): Promise<void> {
  foldCandidates.delete(turnId)
  await changeTurn($, turnId, t => (t.folded === folded && t.autoFolded ? null : { ...t, folded, autoFolded: true, changedAt: now }))
}

/** Folds a finished turn by the `next` rule, unless it folded once already or the user chose; decided at write time. */
async function autoFold($: EngineInterface, turnId: string, now: number): Promise<void> {
  await changeTurn($, turnId, t => (t.status === 'running' || t.autoFolded ? null : { ...t, folded: true, autoFolded: true, changedAt: now }))
}

/**
 * Notes the turn each key is filed under, as the row member written next says. A key filed under another turn before is
 * moved out of memory for good (its draws read the member); returns true when one moved, so the rows are asked to redraw.
 */
function noteRows(keys: readonly string[], turnId: string): boolean {
  if (rowTurn.size >= MAX_KNOWN_ROWS) rowTurn.clear()
  let moved = false
  for (const raw of keys) {
    const key = rowKeyOf(raw)
    if (movedRows.has(key)) continue
    const was = rowTurn.get(key)
    if (was !== undefined && was !== turnId) {
      rowTurn.delete(key)
      movedRows.add(key)
      moved = true
      continue
    }
    rowTurn.set(key, turnId)
  }

  return moved
}

/** The turn a row belongs to as this load filed it or the store restored it, read from memory: its own key, or a group's calls. */
function knownTurnOf(requestId: string, component: string, props: RowProps): string | undefined {
  const own = rowTurn.get(requestId) ?? restoredRows.get(requestId)
  if (own !== undefined || component !== 'ToolGroup') return own
  for (const call of props.calls ?? []) {
    if (call.tool_use_id === undefined) continue
    const key = rowKeyOf(call.tool_use_id)
    const id = rowTurn.get(key) ?? restoredRows.get(key)
    if (id !== undefined) return id
  }

  return undefined
}

/**
 * The turn a row belongs to: its own row member, or for a group the member of its first call that has one. Where a row has
 * no member, the rows restored from the store answer (the member is read first, so the draw keeps following the state).
 */
async function turnIdOf($: EngineInterface, requestId: string, component: string, props: RowProps): Promise<string | undefined> {
  const direct = await read($, { plugin: 'claudefolder', key: 'row', id: rowKeyOf(requestId) } as const)
  if (direct !== undefined) return direct
  const restored = restoredRows.get(rowKeyOf(requestId))
  if (restored !== undefined) return restored
  if (component === 'ToolGroup') {
    for (const call of props.calls ?? []) {
      if (call.tool_use_id === undefined) continue
      const id = await read($, { plugin: 'claudefolder', key: 'row', id: rowKeyOf(call.tool_use_id) } as const)
      if (id !== undefined) return id
      const back = restoredRows.get(rowKeyOf(call.tool_use_id))
      if (back !== undefined) return back
    }
  }

  return undefined
}

/** The tracker's agent count as one comparable string. */
const agentsKey = (t: Tracker): string => [...t.agents].join(',') + '|' + t.lastPending

/** Keeps the tracker's agent count in the state, so a reload of the module goes on from it; never throws. */
function saveAgents($: EngineInterface): void {
  void $.state.set({ plugin: 'claudefolder', key: 'agents' } as const, { pending: [...tracker.agents], last: tracker.lastPending }).catch(() => undefined)
}

/** The id of the background agent an Agent or SendMessage call launched or resumed, from the tool's record; else null. */
function launchedAgentOf(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (r.status === 'async_launched' && typeof r.agentId === 'string') return r.agentId
  if (typeof r.resumedAgentId === 'string') return r.resumedAgentId

  return null
}

/** What `session.append` carries of a row, as far as the mod reads it. */
type AppendEvent = {
  uuid: string
  door: string
  origin?: { kind?: string }
  message: { type: string; name?: string; isMeta?: boolean; content: string | ReadonlyArray<{ type: string; [field: string]: unknown }> }
}

function rowOf(e: AppendEvent): AppendRow {
  const blocks: Block[] = []
  const raw = e.message.content
  const content: ReadonlyArray<{ type: string; [field: string]: unknown }> =
    typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : []
  for (const b of content) {
    blocks.push({
      type: String(b.type),
      text: typeof b.text === 'string' ? b.text : undefined,
      id: typeof b.id === 'string' ? b.id : undefined,
      tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
    })
  }

  const name = typeof e.message.name === 'string' ? e.message.name : undefined
  const origin = typeof e.origin?.kind === 'string' ? e.origin.kind : undefined

  return {
    uuid: e.uuid,
    door: e.door,
    type: e.message.type,
    isMeta: e.message.isMeta === true,
    blocks,
    ...(name === undefined ? {} : { name }),
    ...(origin === undefined ? {} : { origin }),
  }
}

/** The first 8 characters of an id, for the debug lines; `none` for null. */
const shortId = (id: string | null | undefined): string => (id === null || id === undefined ? 'none' : id.slice(0, 8))

/** Asks every row this plugin draws to draw again (ten a second at most); logs why. */
function redrawAll($: EngineInterface, reason: string): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // A redraw is a convenience: the rows still follow their own state reads.
  }
  $.ui.log(`claudefolder: invalidate ${reason}`, { to: 'debug' })
}

/**
 * Asks one redraw of every row a frame from now, for what a row cannot follow through the state it reads (a header drawn
 * for the first time, a row filed under another turn). Asks made while one waits share it.
 */
function askRedraw($: EngineInterface, reason: string): void {
  if (redrawPending) return
  redrawPending = true
  try {
    $.clock.after(FRAME_MS, () => {
      redrawPending = false
      redrawAll($, reason)
    })
  } catch {
    redrawPending = false
  }
}

/** Logs a row's draw outcome when it changed since the last one logged for that requestId. */
function noteDraw($: EngineInterface, component: string, requestId: string, outcome: string): void {
  if (lastOutcome.get(requestId) === outcome) return
  if (lastOutcome.size >= 2000) lastOutcome.clear()
  lastOutcome.set(requestId, outcome)
  $.ui.log(`claudefolder: draw ${component} ${shortId(requestId)} ${outcome}`, { to: 'debug' })
}

/** Where `onAppend` put a row, for the debug line: its turn, a finished turn's tail, the pending group, or nowhere. */
function whereOf(res: Appended, row: AppendRow): string {
  const own = rowKeyOf(row.uuid)
  const to = res.to
  const moved = to !== null && !res.assign.includes(own)
  const where = to === null ? '' : (to === tracker.running ? 'turn ' : 'tail ') + (turnNumbers.get(to) ?? '?')
  if (to !== null && !moved) return where
  const p = tracker.pending
  const base = p === null || !p.ids.includes(own) ? 'unassigned' : 'pending ' + p.kind

  return moved ? `${base}, moved ${res.assign.length} to ${where}` : base
}

/**
 * Writes what filing a row decided: the row members of its ids, and for a finished turn the closer when the row moved it
 * (a tail row, the duration line). The running turn's closer and header are written when it completes (`turn.complete`
 * reads them from the tracker).
 */
async function writeFiling($: EngineInterface, res: Appended, isRunning: boolean): Promise<void> {
  const to = res.to
  if (to === null) return
  await Promise.all(res.assign.map(id => $.state.set({ plugin: 'claudefolder', key: 'row', id: rowKeyOf(id) } as const, to)))
  const closer = res.closer
  // The rows of the closer's turn read it while drawing: the write draws them again (no invalidate).
  if (!isRunning && closer !== null) await changeTurn($, to, t => (t.closer === closer ? null : { ...t, closer }))
  // The saved session keeps the row keys: a row filed while the turn runs is saved later, a tail row soon.
  if (res.assign.length > 0) scheduleSave($, isRunning ? RUNNING_SAVE_DELAY_MS : SAVE_DELAY_MS)
}

// ---- the saved session -------------------------------------------------------------------------
// `$.state` is wiped when a session ends, so each session's turns are also kept in the mod's own store (`$.store`), keyed by
// the session id, and put back at `session.start`: a restart or a `--continue`/`--resume` finds its folds as it left them.

/**
 * Saves the session's turns `delay` ms from now; a burst of changes shares one save. A save already waiting on a shorter
 * delay stands; one waiting on a longer delay is moved to this one.
 */
function scheduleSave($: EngineInterface, delay = SAVE_DELAY_MS): void {
  if (saveTimer !== null && saveDelay <= delay) return
  saveTimer?.cancel()
  saveTimer = null
  try {
    saveDelay = delay
    saveTimer = $.clock.after(delay, () => {
      saveTimer = null
      void saveSession($).catch(() => undefined)
    })
  } catch {
    saveTimer = null
  }
}

/**
 * Removes other sessions from the store: all but the `keep` newest, and any whose entry is over `maxSize` characters of
 * JSON. `mine` is never removed.
 */
async function pruneSessions($: EngineInterface, mine: string, keep: number, maxSize = Infinity): Promise<void> {
  const others: { key: string; savedAt: number; size: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(SAVE_PREFIX) || key === mine) continue
    const value = (await $.store.get(key)) as { savedAt?: unknown } | null | undefined
    const size = maxSize === Infinity ? 0 : (JSON.stringify(value ?? null)?.length ?? 0)
    others.push({ key, savedAt: typeof value?.savedAt === 'number' ? value.savedAt : 0, size })
  }
  others.sort((a, b) => b.savedAt - a.savedAt)
  for (const [i, old] of others.entries()) if (i >= keep || old.size > maxSize) await $.store.delete(old.key)
}

/** The newest of `turns` that fit in `SESSION_BUDGET` characters of JSON (at least the newest one), oldest first. */
function withinBudget(turns: SavedTurn[]): SavedTurn[] {
  const sizes = turns.map(t => JSON.stringify(t).length + 1)
  let total = sizes.reduce((a, b) => a + b, 200)
  let first = 0
  while (first < turns.length - 1 && total > SESSION_BUDGET) total -= sizes[first++] ?? 0

  return turns.slice(first)
}

/**
 * Writes this session's newest turns to the store; never throws. The older sessions are pruned before the first write of
 * the process; a write the store refuses (it is full) prunes the others down to a few, each within the budget, and is tried
 * once more.
 */
async function saveSession($: EngineInterface): Promise<void> {
  try {
    const sessionId = await $.session.id()
    const ids = (await read($, order)).slice(-MAX_SAVED_TURNS)
    // The rows of turns restored from the store are known by `restoredRows` alone.
    const restored = new Map<string, string[]>()
    for (const [key, turnId] of restoredRows) {
      const keys = restored.get(turnId) ?? []
      keys.push(key)
      restored.set(turnId, keys)
    }
    const members = await Promise.all(ids.map(turnId => read($, { plugin: 'claudefolder', key: 'turn', id: turnId } as const)))
    const turns: SavedTurn[] = []
    ids.forEach((turnId, i) => {
      const turn = members[i]
      if (turn === undefined) return
      const rows = [...new Set([...(tracker.ids.get(turnId) ?? []), ...(restored.get(turnId) ?? [])])].slice(0, MAX_ROW_IDS)
      turns.push({ ...turn, ids: rows })
    })
    if (turns.length === 0) return
    const key = SAVE_PREFIX + sessionId
    const entry: SavedSession = { v: 1, savedAt: await $.clock.now(), nextN, turns: withinBudget(turns) }
    if (!pruned) {
      pruned = true
      await pruneSessions($, key, MAX_SAVED_SESSIONS - 1)
    }
    try {
      await $.store.set(key, entry)
    } catch {
      // The store is full (over 4 MiB): keep a few small sessions besides this one, and try once more.
      await pruneSessions($, key, RETRY_KEEP_SESSIONS, SESSION_BUDGET)
      await $.store.set(key, entry)
    }
    $.ui.log(`claudefolder: saved ${entry.turns.length} turns`, { to: 'debug' })
  } catch {
    // A failed save leaves the store as it was; the next change tries again.
    $.ui.log('claudefolder: save failed', { to: 'debug' })
  }
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** A saved turn when `v` has every field with its type, else null: a malformed turn is dropped. */
function savedTurnOf(v: unknown): SavedTurn | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (
    typeof o.n !== 'number' ||
    typeof o.turnId !== 'string' ||
    typeof o.title !== 'string' ||
    typeof o.reply !== 'string' ||
    typeof o.tools !== 'number' ||
    !isStrings(o.files) ||
    !(o.durationMs === null || typeof o.durationMs === 'number') ||
    typeof o.status !== 'string' ||
    !STATUSES.includes(o.status as string) ||
    typeof o.folded !== 'boolean' ||
    typeof o.autoFolded !== 'boolean' ||
    !(o.header === null || typeof o.header === 'string') ||
    typeof o.changedAt !== 'number' ||
    !(o.closer === null || typeof o.closer === 'string') ||
    !isStrings(o.ids)
  ) {
    return null
  }
  const startKind =
    typeof o.startKind === 'string' && START_KINDS.includes(o.startKind as string) ? (o.startKind as FolderTurn['startKind']) : undefined

  return {
    n: o.n as number,
    turnId: o.turnId as string,
    title: o.title as string,
    reply: o.reply as string,
    tools: o.tools as number,
    files: [...(o.files as string[])],
    durationMs: o.durationMs as number | null,
    status: o.status as FolderStatus,
    folded: o.folded as boolean,
    autoFolded: o.autoFolded as boolean,
    header: o.header as string | null,
    changedAt: o.changedAt as number,
    closer: o.closer as string | null,
    ...(startKind === undefined ? {} : { startKind }),
    ids: [...(o.ids as string[])],
  }
}

/** The saved session in `v` when it is version 1 with its numbers and a list of turns, its malformed turns dropped; else null. */
function savedOf(v: unknown): SavedSession | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.v !== 1 || typeof o.savedAt !== 'number' || typeof o.nextN !== 'number' || !Array.isArray(o.turns)) return null
  const turns: SavedTurn[] = []
  for (const raw of o.turns as unknown[]) {
    const turn = savedTurnOf(raw)
    if (turn !== null) turns.push(turn)
  }

  return { v: 1, savedAt: o.savedAt as number, nextN: o.nextN as number, turns }
}

/** What the store holds for the session this process runs: null when nothing, or nothing valid. */
async function savedOfThisSession($: EngineInterface): Promise<SavedSession | null> {
  return savedOf(await $.store.get(SAVE_PREFIX + (await $.session.id())))
}

/**
 * Puts the turns this session saved back: the members, the order and the numbering in the state, the rows in
 * `restoredRows`, and the tracker's header and closer of each. A turn saved while it ran comes back interrupted. Returns
 * whether any turn came back; never throws.
 */
async function restoreSession($: EngineInterface): Promise<boolean> {
  try {
    const saved = await savedOfThisSession($)
    if (saved === null || saved.turns.length === 0) return false
    const turnIds: string[] = []
    for (const { ids, ...member } of saved.turns) {
      const turn: FolderTurn = { ...member, status: member.status === 'running' ? 'interrupted' : member.status }
      await $.state.set({ plugin: 'claudefolder', key: 'turn', id: turn.turnId } as const, turn)
      for (const key of ids) restoredRows.set(key, turn.turnId)
      if (turn.closer !== null) tracker.closers.set(turn.turnId, { id: turn.closer, sticky: true })
      if (turn.header !== null) tracker.headers.set(turn.turnId, turn.header)
      turnNumbers.set(turn.turnId, turn.n)
      turnIds.push(turn.turnId)
    }
    await $.state.set({ plugin: 'claudefolder', key: 'order' } as const, turnIds)
    nextN = Math.max(saved.nextN, ...saved.turns.map(t => t.n + 1))
    tracker.last = turnIds[turnIds.length - 1] ?? null
    $.ui.log(`claudefolder: restored ${turnIds.length} turns next=${nextN}`, { to: 'debug' })

    return true
  } catch {
    // A failed restore leaves the session plain: its history draws as the engine does.
    return false
  }
}

/** After a reload the turns are still in the state, but the rows of a restored turn were never written there: maps them again from the store. */
async function remapRows($: EngineInterface, known: readonly string[]): Promise<void> {
  try {
    const saved = await savedOfThisSession($)
    if (saved === null) return
    const turnIds = new Set(known)
    for (const { turnId, ids } of saved.turns) {
      if (turnIds.has(turnId)) for (const key of ids) restoredRows.set(key, turnId)
    }
  } catch {
    // The rows of a restored turn then draw as the engine does until the next restart.
  }
}

/** Reads the state a reloaded module continues from; never throws (a failed read leaves the fresh start). */
async function recover($: EngineInterface): Promise<void> {
  let count = 0
  let running: string | null = null
  try {
    // After a reload the turns are still in the state: the numbering goes on, a turn still running is followed again.
    let ids = await read($, order)
    let restored = false
    if (ids.length === 0) {
      // A process that holds no turns yet (a restart, a resume) takes back the turns this session saved.
      restored = await restoreSession($)
      if (restored) ids = await read($, order)
    } else {
      // A reload keeps the turns in the state, but the rows of a restored turn were never written there: map them again.
      await remapRows($, ids)
    }
    count = ids.length
    if (!restored) nextN = ids.length + 1
    const newest = ids[ids.length - 1]
    if (newest !== undefined) {
      const member = await read($, { plugin: 'claudefolder', key: 'turn', id: newest } as const)
      if (member !== undefined && member.status === 'running') {
        tracker.running = newest
        tracker.runningHeader = member.header
        if (member.header !== null) tracker.headers.set(newest, member.header)
        counters.set(newest, { tools: member.tools, files: [...member.files] })
        turnNumbers.set(newest, member.n)
        running = newest
      }
    }
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]
      if (id === undefined) continue
      const member = await read($, { plugin: 'claudefolder', key: 'turn', id } as const)
      if (member !== undefined && member.status !== 'running') {
        // The module is new, its tracker empty: the closer comes from the member, sticky, so a log line the reload itself
        // appends is not filed under the turn (and drawn inside its card, below the bottom border).
        resumeLast(tracker, id, member.closer)
        turnNumbers.set(id, member.n)
        break
      }
    }
    // A reload goes on counting the background agents (after a restart the state is empty, as the engine's agents are gone).
    const kept = await read($, agentsAtom)
    tracker.agents = new Set(kept.pending)
    tracker.lastPending = kept.last
    // The tints follow the terminal's theme: the user's `theme` setting, dark when it is not a light one or cannot be read.
    try {
      palette = paletteFor(await $.settings.read({ key: 'theme' }))
    } catch {
      palette = PALETTES.dark
    }
  } catch {
    // A failed read leaves the numbering and the tracker as a fresh load has them.
  }
  $.ui.log(`claudefolder: recovered order=${count} next=${nextN} running=${shortId(running)}`, { to: 'debug' })
  // The headers are built again with the palette just read.
  headCache.clear()
  // A module loaded into a running session (or a /config change) redraws every row once: its rows were drawn before it
  // could mark or map them. The load's only invalidate.
  $.clock.after(0, () => redrawAll($, 'load'))
}

/**
 * Runs the recovery once per load, from the first hook that comes (a module hot-loaded into a running session never gets
 * a `session.start`). Callers check `recovered` first, so the common path awaits nothing.
 */
async function ensureRecovered($: EngineInterface): Promise<void> {
  if (recovered) return
  recovery ??= recover($).finally(() => {
    recovered = true
  })
  await recovery
}

/** The title the header shows: the engine's own words for an agent's message or a notification, else the turn's title. */
function displayTitle(turn: FolderTurn, component: string, props: RowProps): string {
  if (component !== 'UserMessage') return turn.title
  const name = props.from?.name
  if (turn.startKind === 'peer' && typeof name === 'string' && name.trim() !== '') return `Message from @${name.trim()}`
  // A notification row draws the engine's own words (`Agent "x" finished`): also for a turn saved before it had its kind.
  const isNotice = turn.startKind === 'notification' || props.task !== undefined
  if (isNotice && typeof props.text === 'string' && props.text.trim() !== '') return titleOf(props.text, null)

  return turn.title
}

/**
 * A new turn's title: a task notification's summary; else a command's title, the turn's text as given, or (no text) its
 * starter's words with their tags removed.
 */
function titleFor(text: string, starter: string | null, command: string | null): string {
  const source = text.trim() !== '' ? text : (starter ?? '')
  const notified = command === null ? notificationTitleOf(source) : null
  if (notified !== null) return titleOf(notified, null)

  return text.trim() !== '' ? titleOf(text, command) : titleOf(stripTags(starter ?? ''), command)
}

/** The finished turns, oldest first. */
async function finishedTurns($: EngineInterface): Promise<FolderTurn[]> {
  const turns: FolderTurn[] = []
  for (const id of await read($, order)) {
    const t = await read($, { plugin: 'claudefolder', key: 'turn', id } as const)
    if (t !== undefined && t.status !== 'running') turns.push(t)
  }

  return turns
}

const plural = (n: number): string => `${n} turn${n === 1 ? '' : 's'}`

/** `/folder`: the answer text for the arguments, after writing the fold states they ask for. */
async function runFolder($: EngineInterface, args: string): Promise<string> {
  const turns = await finishedTurns($)
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const now = await $.clock.now()
  const apply = async (targets: FolderTurn[], folded: boolean): Promise<void> => {
    if (targets.length === 0) return
    // The rows read their turn while drawing: these writes draw exactly those turns' rows again (no invalidate).
    await Promise.all(targets.map(t => setFolded($, t.turnId, folded, now)))
    scheduleSave($)
  }
  if (words.length === 0) {
    if (turns.length === 0) return 'No finished turn yet.'
    const open = turns.some(t => t.folded)
    await apply(turns, !open)

    return `${open ? 'Opened' : 'Folded'} ${plural(turns.length)}.`
  }
  const verb = words[0]
  if ((verb !== 'open' && verb !== 'close') || words.length > 2) return USAGE_TEXT
  const folded = verb === 'close'
  const word = folded ? 'Folded' : 'Opened'
  const target = words[1]
  if (target === undefined) {
    // No target: the newest turn that the verb changes (a folded one to open, an open one to close).
    const newest = [...turns].reverse().find(t => t.folded !== folded)
    if (newest === undefined) return folded ? 'No open turn to close.' : 'No folded turn to open.'
    await apply([newest], folded)

    return `${word} turn #${newest.n}.`
  }
  if (target === 'all') {
    if (turns.length === 0) return 'No finished turn yet.'
    await apply(turns, folded)

    return `${word} ${plural(turns.length)}.`
  }
  if (target === 'last') {
    const last = turns[turns.length - 1]
    if (last === undefined) return 'No finished turn yet.'
    await apply([last], folded)

    return `${word} turn #${last.n}.`
  }
  if (!/^\d+$/.test(target)) return USAGE_TEXT
  const n = Number(target)
  const one = turns.find(t => t.n === n)
  if (one === undefined) return `No turn #${n}.`
  await apply([one], folded)

  return `${word} turn #${n}.`
}

export const register: Register = (on, options) => {
  settings = normalizeSettings(options)
  palette = PALETTES.dark
  // A fresh load starts from a clean state.
  for (const t of foldTimers.values()) t.cancel()
  foldTimers.clear()
  tracker = createTracker()
  counters.clear()
  lastExpandedView = false
  headerSeen.clear()
  unseenDrawn.clear()
  redrawPending = false
  rowTurn.clear()
  movedRows.clear()
  foldCandidates.clear()
  foldScanNeeded = true
  headCache.clear()
  lastOutcome.clear()
  headerChange.clear()
  clientFailed = false
  nextN = 1
  recovered = false
  recovery = null
  turnNumbers.clear()
  restoredRows.clear()
  saveTimer = null
  saveDelay = 0
  pruned = false

  // The session's turns come back from the store here (`recover` restores them when this process holds none).
  on('session.start', async ($, e, next) => {
    if (!recovered) await ensureRecovered($)
    await $.command.register({
      name: 'folder',
      description: 'Fold or unfold finished turns: /folder toggles them all; open or close one by number, the last or all',
      argumentHint: '[open | close] [<n> | last | all]',
    })
    // No invalidate here: the recovery asked the load's one redraw.

    return next(e)
  })

  // A session ends (a /clear, a resume, an exit): its turns are saved at once, then forgotten, so that the session the process
  // goes on under (a /clear numbers its turns from 1 again) starts clean and recovers its own turns from the store.
  on('session.end', async ($, e, next) => {
    await saveSession($)
    for (const t of foldTimers.values()) t.cancel()
    foldTimers.clear()
    tracker = createTracker()
    counters.clear()
    headerSeen.clear()
    unseenDrawn.clear()
    rowTurn.clear()
    movedRows.clear()
    foldCandidates.clear()
    foldScanNeeded = true
    headCache.clear()
    lastOutcome.clear()
    headerChange.clear()
    turnNumbers.clear()
    restoredRows.clear()
    await $.state.set({ plugin: 'claudefolder', key: 'order' } as const, [])
    nextN = 1
    recovered = false
    recovery = null

    return next(e)
  })

  // Each row of the main conversation is filed under its turn by its id. Observes only: the row is stored as it was.
  // The tracker files it before `next`, in append order (module memory: nothing awaited); the state writes follow.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (!recovered) await ensureRecovered($)
    const row = rowOf(e)
    const agentsBefore = agentsKey(tracker)
    const res = onAppend(tracker, row)
    if (agentsKey(tracker) !== agentsBefore) saveAgents($)
    const isRunning = res.to !== null && res.to === tracker.running
    $.ui.log(
      `claudefolder: append ${row.door} ${row.type}${row.isMeta ? ' meta' : ''}${row.name === undefined ? '' : ' ' + row.name}${row.origin === undefined ? '' : ' ' + row.origin} ${shortId(row.uuid)} -> ${whereOf(res, row)}`,
      { to: 'debug' },
    )
    const r = await next(e)
    if (r.deny === undefined) {
      // Memory first, as the row members are written next: a draw finds the row's turn with no state read.
      if (res.to !== null && noteRows(res.assign, res.to)) askRedraw($, 'moved')
      void writeFiling($, res, isRunning).catch(() => undefined)
    }

    return r
  }).catch(($, e, next) => next(e))

  // A main-loop turn starts: it adopts the rows that came before it and, under `next`, the finished turns fold.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (!recovered) await ensureRecovered($)
    const turnId = e.turnId
    const res = onTurnStart(tracker, turnId)
    const now = await $.clock.now()
    // Only the first turn.start of a load looks at every earlier turn; later ones fold the turns this load saw complete.
    const scan = settings.foldWhen === 'next' && foldScanNeeded
    const prior = scan ? await read($, order) : []
    if (noteRows(res.assign, turnId)) askRedraw($, 'moved')
    await Promise.all(res.assign.map(id => $.state.set({ plugin: 'claudefolder', key: 'row', id: rowKeyOf(id) } as const, turnId)))
    // The member is built from the tracker as it is now: a starter row filed while the awaits above ran counts.
    const turn: FolderTurn = {
      n: nextN++,
      turnId,
      // A turn with no typed prompt (a hand-back, a notification) takes its title from its starter row's words.
      title: titleFor(e.text, res.text, res.command),
      reply: '',
      tools: 0,
      files: [],
      durationMs: null,
      status: 'running',
      folded: false,
      autoFolded: false,
      header: tracker.running === turnId ? tracker.runningHeader : res.header,
      changedAt: 0,
      closer: res.closer,
      startKind: res.startKind,
    }
    turnNumbers.set(turnId, turn.n)
    $.ui.log(
      `claudefolder: turn.start ${turn.n} ${shortId(turnId)} header=${shortId(turn.header)} start=${res.startKind} adopted=${res.assign.length}`,
      { to: 'debug' },
    )
    await $.state.set({ plugin: 'claudefolder', key: 'turn', id: turnId } as const, turn)
    await update($, order, ids => [...ids, turnId])
    counters.set(turnId, { tools: 0, files: [] })
    if (settings.foldWhen === 'next') {
      // Each fold is a write to that turn: its rows draw again on their own (no invalidate).
      const targets = scan ? prior : [...foldCandidates]
      foldScanNeeded = false
      foldCandidates.clear()
      await Promise.all(targets.filter(id => id !== turnId).map(id => autoFold($, id, now)))
    }
    scheduleSave($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Each tool call of the main loop counts toward the running turn, and files its row. A pass-through: nothing awaited before `next`.
  on('tool.call', async ($, e, next) => {
    const running = tracker.running
    if (e.agentId === undefined && running !== null) {
      const c = counters.get(running)
      if (c !== undefined) {
        c.tools += 1
        const file = fileOf(e.tool, e as unknown)
        if (file !== null && !c.files.includes(file) && c.files.length < 20) c.files.push(file)
      }
      // `onAppend` files a call's id with its response row: write it only when that has not happened (a write draws the row again).
      const key = typeof e.tool_use_id === 'string' ? rowKeyOf(e.tool_use_id) : null
      if (key !== null && rowTurn.get(key) !== running) {
        if (noteRows([key], running)) askRedraw($, 'moved')
        void $.state.set({ plugin: 'claudefolder', key: 'row', id: key } as const, running).catch(() => undefined)
      }
    }
    const r = await next(e)
    // A background agent the main loop launched or resumed: pending until its task notification (the duration rule).
    if (e.agentId === undefined && (e.tool === 'Agent' || e.tool === 'SendMessage') && r.deny === undefined) {
      const id = launchedAgentOf(r.result)
      if (id !== null && !tracker.agents.has(id)) {
        onAgentLaunched(tracker, id)
        saveAgents($)
      }
    }

    return r
  }).catch(($, e, next) => next(e))

  // A main-loop turn ends: its summary is written, and under `finish` it folds a moment later. Observes only.
  on('turn.complete', async ($, e, next) => {
    if (!recovered) await ensureRecovered($)
    const r = await next(e)
    if (e.agentId !== undefined) return r
    const turnId = e.turnId
    try {
      onTurnComplete(tracker, turnId)
      const c = counters.get(turnId)
      const reply = replyOf(e.answer)
      const status = e.reason === 'aborted' ? 'interrupted' : e.reason === 'answer' ? 'done' : 'error'
      const late = tracker.lateCommands.get(turnId)
      await changeTurn($, turnId, t => ({
        ...t,
        title: late === undefined ? t.title : titleOf('', late),
        reply,
        tools: c === undefined ? t.tools : c.tools,
        files: c === undefined ? t.files : [...c.files],
        durationMs: e.durationMs,
        status,
        // The final values come from memory at the end: a lost race during the turn cannot leave them empty.
        header: tracker.headers.get(turnId) ?? t.header ?? null,
        closer: tracker.closers.get(turnId)?.id ?? t.closer,
      }))
      $.ui.log(
        `claudefolder: turn.complete ${turnNumbers.get(turnId) ?? '?'} header=${shortId(tracker.headers.get(turnId))} closer=${shortId(tracker.closers.get(turnId)?.id)} status=${status}`,
        { to: 'debug' },
      )
      // The turn's rows read it while drawing (they drew it running): this write draws exactly them again, no invalidate.
      if (settings.foldWhen === 'next') foldCandidates.add(turnId)
      scheduleSave($)
      if (settings.foldWhen === 'finish') {
        foldTimers.set(
          turnId,
          $.clock.after(FOLD_DELAY_MS, () => {
            foldTimers.delete(turnId)
            void (async () => {
              const now = await $.clock.now()
              // The write draws the turn's rows again; a turn already folded once, or running, is not written.
              await changeTurn($, turnId, t => (t.autoFolded || t.status === 'running' ? null : { ...t, folded: true, autoFolded: true, changedAt: now }))
            })().catch(() => undefined)
          }),
        )
      }
    } catch {
      // The summary is a convenience: a failure here leaves the turn as the engine draws it.
    }

    return r
  }).catch(($, e, next) => next(e))

  // The rows of a turn: the header row draws the fold, the others of a folded turn draw nothing.
  on(
    'ui.render',
    { component: ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'TurnDuration', 'CommandOutput'] },
    async ($, e, next) => {
      // Folding needs the fullscreen terminal: the main screen prints rows into the scrollback, which cannot be redrawn.
      if (e.surface !== 'terminal' || e.viewport?.isFullscreen !== true) return next(e)
      const props = e.props as unknown as RowProps
      const component = e.component
      // The engine draws a row under its uuid with the last group zeroed: rows are keyed by `rowKeyOf`, as the tracker files them.
      const requestId = rowKeyOf(e.requestId)
      // Read first, and never write: a draw that reads no state stops following it (the engine drops its subscription).
      // A row this load filed, or the store restored, is known in memory: the turn read alone subscribes the draw, and every
      // write to that turn draws it again. Any other row reads its row member (and a group its calls'), as before.
      const id = knownTurnOf(requestId, component, props) ?? (await turnIdOf($, requestId, component, props))
      const turn = id === undefined ? undefined : await read($, { plugin: 'claudefolder', key: 'turn', id } as const)
      // An agent's message or a notification can be drawn whole under a speaker label in the normal view: its flag is not the view's.
      const isMessageRow = component === 'UserMessage' && (props.from !== undefined || props.task !== undefined)
      if (component === 'TurnDuration' || (component === 'UserMessage' && !isMessageRow)) lastExpandedView = props.isExpanded === true
      const followsView = component === 'AssistantMessage' || component === 'CommandOutput' || isMessageRow
      // ctrl+o and --verbose draw every row in full.
      if ((props.isExpanded === true && !isMessageRow) || (followsView && lastExpandedView)) {
        noteDraw($, component, requestId, 'expanded')
        return next(e)
      }
      if (turn === undefined) {
        noteDraw($, component, requestId, 'unmapped')
        return next(e)
      }
      if (turn.status === 'running') {
        noteDraw($, component, requestId, 'running')
        return next(e)
      }
      const header = turn.header
      const isHeader =
        header !== null &&
        component !== 'ToolResult' &&
        (requestId === rowKeyOf(header) || (component === 'ToolGroup' && (props.calls ?? []).some(c => c.tool_use_id !== undefined && rowKeyOf(c.tool_use_id) === rowKeyOf(header))))
      if (isHeader) {
        headerSeen.add(turn.turnId)
        // Rows of this turn drew open while it was folded, its header not yet drawn: one redraw (shared by a burst) hides them.
        if (unseenDrawn.delete(turn.turnId) && turn.folded) askRedraw($, 'collapse')
      }
      const { Box, Text, Button } = $.ui.resolve(e)
      if (!isHeader && turn.folded) {
        // A folded turn's other rows hide only once its header row has drawn: a turn never vanishes.
        if (headerSeen.has(turn.turnId)) {
          noteDraw($, component, requestId, 'hidden')

          return <Box />
        }
        unseenDrawn.add(turn.turnId)
      }
      const isRail = settings.style === 'rail'
      const isBoxed = settings.style === 'boxed'
      const Client = e.surface === 'terminal' ? $.ui.resolve(e).Client : undefined
      const scope = SCOPE_PREFIX + turn.n
      const columns = e.viewport?.columns ?? DEFAULT_COLUMNS
      const W = Math.max(20, Math.min(512, columns) - 2)
      // The row under which an open card closes: the turn's closer row (a call's own row never closes it; its result row does).
      const closer = turn.closer
      const isCloser =
        closer !== null &&
        component !== 'ToolUse' &&
        (requestId === rowKeyOf(closer) || (component === 'ToolGroup' && (props.calls ?? []).some(c => c.tool_use_id !== undefined && rowKeyOf(c.tool_use_id) === rowKeyOf(closer))))
      // The edge bar down a row of an open turn: an absolutely placed one-column Box the height of the row it wraps, clipped to it,
      // starting at `top`, the row's first line on screen (`barStart`); null draws no bar.
      // Plain Text: the bar carries no hover and no light; only a header's text reacts to the pointer.
      const railed = (node: Awaited<ReturnType<typeof next>>, top: number | null) => (
        <Box flexDirection="column" paddingLeft={2}>
          {node}
          {top === null ? null : (
            <Box position="absolute" top={top} bottom={0} left={0} width={1} overflow="hidden">
              <Text color={hex(palette.rail)}>{railText(settings.edge)}</Text>
            </Box>
          )}
        </Box>
      )
      // The open card's side bar at column `x`, from row `top` down: the same mechanism as the rail, in the card's color.
      const sideBar = (x: number, top: number) => (
        <Box position="absolute" top={top} bottom={0} left={x} width={1} overflow="hidden">
          <Text color={hex(palette.frameOpen)}>{edgeText()}</Text>
        </Box>
      )
      // A row of an open boxed turn: its content two columns inside the card's sides; the closer row adds the card's bottom border.
      // No `width` here (nor display, overflow, position, height, min sizes or offsets): the engine refuses its own node under a Box
      // that sets one. The margin ends the box where the header's right corner ends, and the right side sits at that column.
      // The sides start at `top` (`barStart`); null draws none (the row is outside the viewport, or only its border is on screen).
      const framed = (node: Awaited<ReturnType<typeof next>>, closes: boolean, top: number | null) => (
        <Box flexDirection="column">
          <Box flexDirection="column" marginRight={2} paddingLeft={2} paddingRight={2}>
            {node}
            {top === null ? null : sideBar(0, top)}
            {top === null ? null : sideBar(W - 1, top)}
          </Box>
          {closes ? (
            <Text>
              {runsAll(cardBottom(W, palette)).map(r => (
                <Text color={hex(r.fg)} backgroundColor={hex(r.bg)}>
                  {r.text}
                </Text>
              ))}
            </Text>
          ) : null}
        </Box>
      )
      if (!isHeader) {
        noteDraw($, component, requestId, turn.folded ? 'open-unseen' : isRail ? 'railed' : isBoxed ? 'framed' : 'plain')
        // The bars start at the row's first line on screen: the closer's bottom border is the one row of the tree below them.
        const top = barStart(props.onScreen, 0, isBoxed && isCloser ? 1 : 0)
        if (isRail) return railed(await next(e), top)
        if (isBoxed) return framed(await next(e), isCloser, top)

        return next(e)
      }
      noteDraw($, component, requestId, turn.folded ? 'header-folded' : 'header-open')

      // The header: drawn by its surface module, which hears the pointer; if the module has failed, as plain Text with Buttons over the text.
      const folded = turn.folded
      // Only a fold or an unfold this load saw is drawn as an effect, and only then is the clock read.
      const animate = Client !== undefined && !clientFailed && settings.motion !== 'off' && seesChange(turn)
      const now = animate ? await $.clock.now() : 0
      const engine = folded ? null : await next(e)
      // The header at rest, built once per change of what it shows: the module animates it itself from these cells.
      const rest = headRest(turn, displayTitle(turn, component, props), columns)
      const model = rest.model
      const press = () => void toggle($, turn.turnId).catch(() => undefined)

      let body: JSX.Element
      if (Client !== undefined && !clientFailed) {
        const fx = animate ? foldFx(turn, model, now) : undefined
        // The effect is over: this header's later draws read no clock until its turn folds or opens again.
        if (animate && fx === undefined && now - turn.changedAt >= FX_WINDOW_MS) settleChange(turn.turnId)
        const headProps: FolderHeadProps = fx === undefined ? rest.props : { ...rest.props, fx }
        body = <Client key={HEAD_PREFIX + turn.n} module="./headerClient.tsx" width={W} props={headProps} />
      } else {
        const rows: Cell[][] = composeRows(restMotion, turn.turnId, model, settings.marker, palette, 'off')
        const texts = composeText(restMotion, turn.turnId, model, palette, 'off')
        // The fallback: each row is plain Text; row 0 has its marker and the number as a Button between plain Text before and after.
        const runTexts = (cells: TextCell[]) =>
          textRuns(cells).map(run => (
            <Text
              color={run.fg === null ? undefined : hex(run.fg)}
              backgroundColor={run.bg === null ? undefined : hex(run.bg)}
              bold={run.bold ? true : undefined}
              dimColor={run.dim ? true : undefined}
            >
              {run.text}
            </Text>
          ))
        body = (
          <Box flexDirection="column">
            {model.rows.map((row, r) => {
              const text = row.text
              if (text === null) {
                return (
                  <Box flexDirection="row">
                    <Text>
                      {runsAll(rows[r] ?? []).map(run => (
                        <Text color={hex(run.fg)} backgroundColor={hex(run.bg)}>
                          {run.text}
                        </Text>
                      ))}
                    </Text>
                  </Box>
                )
              }
              const cells = lineCells(rows, texts, model, r)
              const p = row.press
              const before = p === null ? cells : cells.filter(c => c.col < p.col)
              const inside = p === null ? [] : cells.filter(c => c.col >= p.col && c.col < p.col + p.width)
              const after = p === null ? [] : cells.filter(c => c.col >= p.col + p.width)

              return (
                <Box flexDirection="row">
                  {before.length === 0 ? null : <Text wrap="truncate-end">{runTexts(before)}</Text>}
                  {p === null ? null : (
                    <Button
                      plain
                      key={KEY_PREFIX + turn.n}
                      hover={{ scope, color: hex(palette.hoverTitle) }}
                      onPress={press}
                    >
                      <Text wrap="truncate-end">{runTexts(inside)}</Text>
                    </Button>
                  )}
                  {after.length === 0 ? null : <Text wrap="truncate-end">{runTexts(after)}</Text>}
                </Box>
              )
            })}
          </Box>
        )
      }
      const headerTree = (
        <Box flexDirection="column">
          {isRail ? (
            // The gap line: one blank line with no bar. The space is painted, not left empty, so a bar reaching down from the
            // row above (the rail of the previous open turn) is overwritten here instead of showing through.
            <Box height={1}>
              <Text> </Text>
            </Box>
          ) : null}
          {body}
        </Box>
      )
      if (folded) return headerTree

      return (
        <Box flexDirection="column">
          {headerTree}
          {engine === null
            ? null
            : isRail
              ? railed(engine, barStart(props.onScreen, model.rows.length + 1, 0))
              : isBoxed
                ? framed(engine, isCloser, barStart(props.onScreen, model.rows.length, isCloser ? 1 : 0))
                : engine}
        </Box>
      )
    },
  )

  // What the module's instance posts: a press released on a header's marker and number (the turn folds or opens); anything else is ignored.
  on('ui.message', async ($, e) => {
    if (!e.element.startsWith(HEAD_PREFIX)) return {}
    const data = e.data as { type?: unknown; turnId?: unknown } | null
    if (data === null || typeof data !== 'object') return {}
    // Test seam: the module never posts this. Answered, it hands the instance props it cannot draw, so it fails for real (`ui.fault`).
    if (data.type === 'fault') return { props: {} }
    if (typeof data.turnId !== 'string') return {}
    if (data.type === 'toggle') void toggle($, data.turnId).catch(() => undefined)

    return {}
  })

  // A header module that fails is left out: every header falls back to plain Text with Buttons over its text.
  on('ui.fault', async ($, e, next) => {
    if (e.module.endsWith(HEAD_MODULE)) {
      clientFailed = true
      redrawAll($, 'fault')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // /folder: the keyboard way to fold and unfold, and the explanation where folding is not available.
  on('command.run', { command: 'folder' }, async ($, e) => {
    if (!recovered) await ensureRecovered($)
    if (!e.presentation.isFullscreen) return { text: MAIN_SCREEN_TEXT }

    const text = await runFolder($, e.args)
    $.ui.log(`claudefolder: folder ${e.args.trim() === '' ? '(toggle)' : e.args.trim()} -> ${text}`, { to: 'debug' })

    return { text }
  })
}
