/** How much the folds move: `lively`, `subtle`, or not at all. */
export type Motion = 'lively' | 'subtle' | 'off'

/** When a finished turn folds: when the next turn starts, or a moment after it ends. */
export type FoldWhen = 'next' | 'finish'

/** The last message's shimmer color, or none. */
export type Shimmer = 'gold' | 'text' | 'teal' | 'silver' | 'lavender' | 'off'

/** The glyph pair before each turn, folded then open. */
export type Marker = 'triangles' | 'hollow' | 'plus' | 'ascii'

/** How turns stand apart: a tinted band with an edge bar, a card, alternating tints, or a rule. */
export type Style = 'rail' | 'boxed' | 'zebra' | 'rules'

/** The edge bar's glyph in the rail style. */
export type Edge = 'half' | 'thin' | 'line' | 'ascii'

/** The /config settings as the module uses them. */
export type Settings = {
  style: Style
  foldWhen: FoldWhen
  /** How many lines a folded turn's text takes: 1, 2 or 3. */
  lines: 1 | 2 | 3
  marker: Marker
  edge: Edge
  motion: Motion
  shimmer: Shimmer
  /** Folded headers warm with the turn's effort. */
  heat: boolean
  /** Every earlier turn folds when a turn starts, ones the user opened included. */
  foldAll: boolean
}

/** How a turn stands: still going, answered, interrupted by the user, or ended by an error or a refusal. */
export type FolderStatus = 'running' | 'done' | 'interrupted' | 'error'

/** One turn of the main conversation, as the mod keeps it. */
export type FolderTurn = {
  /** The turn's number in this session, from 1. */
  n: number
  /** The engine's id of the turn. */
  turnId: string
  /** The prompt's first non-blank line (a command's `/name args`), at most 200 code points. */
  title: string
  /** The first line of the answer; '' until the turn completes, or when the answer has no text. */
  reply: string
  /** How many tools the main loop called in the turn. */
  tools: number
  /** The basenames of the files the turn edited, unique, in first-edit order, at most 20. */
  files: string[]
  /** How long the turn took (ms); null until it completes. */
  durationMs: number | null
  status: FolderStatus
  /** True while the turn is drawn as its header lines alone. */
  folded: boolean
  /** True once the turn folded by itself or the user chose: it never folds by itself again. */
  autoFolded: boolean
  /** The requestId of the row that draws the header: the turn's starter row (a typed prompt, an agent's message, a notification), else its first reply or tool call; null when none is known. */
  header: string | null
  /** When the turn last folded or unfolded (ms since the epoch); 0 when it never did. */
  changedAt: number
  /**
   * The requestId of the row under which an open boxed card closes: the turn's duration line, else its newest row
   * drawn as a row of its own; null until known.
   */
  closer: string | null
  /** What started the turn: a typed prompt, an agent's message (a hand-back), a notification, or anything else. Missing reads as `typed`. */
  startKind?: 'typed' | 'peer' | 'notification' | 'other'
  /** How many of the main loop's tool calls in the turn failed (an error or a refusal); missing reads as 0. */
  failedTools?: number
  /** While the turn's last message shimmers: the `rowKeyOf` key of that row and when the shimmer started (ms since the epoch); null or missing otherwise. */
  shine?: { row: string; at: number } | null
}

/** A turn as it is saved: the member, and the `rowKeyOf` keys of every row filed under it (at most 400), so a restart can map the rows again. */
export type SavedTurn = FolderTurn & { ids: string[] }

/** What the mod keeps in its own store for one session, under `session:<sessionId>`: the turns in order and the number the next one gets. */
export type SavedSession = {
  v: 1
  /** When it was saved (ms since the epoch): the newest sessions are kept. */
  savedAt: number
  nextN: number
  turns: SavedTurn[]
}

/** A fold or an unfold the header plays on its own clock, from the rest cells in `rows`: the marker flip and one lap of its outline light. */
export type FoldFx = {
  kind: 'fold' | 'unfold'
  /** Ms since the fold or unfold, at the hook's draw. */
  age: number
  /** The marker cell and its glyphs: `[row, col, restCp, restFg, otherCp, otherFg]`; the flip shows `other` first, then `rest`. */
  marker: [row: number, col: number, restCp: number, restFg: number, otherCp: number, otherFg: number]
  /** The flip's gold flash strength (0..1). */
  flash: number
  /** The flash color (`0xRRGGBB`). */
  gold: number
  /** The color of a fold's lap (`0xRRGGBB`) when it is not the header's glint: a failed turn's red. */
  lapColor?: number
}

/**
 * What the header's surface module (`hooks/headerClient.tsx`) is handed for a header: its rows as cells, the pressable
 * ranges, the outline the light runs along and the colors it needs. Plain data only.
 */
export type FolderHeadProps = {
  kind: 'head'
  turnId: string
  /**
   * Per header row, its cells in column order: `[col, text, fg, bg, flags]`; `fg` and `bg` are -1 for the default, `flags`
   * is 1 for bold plus 2 for dim plus 4 for a cell of the text region, plus 8 for a run: `text` then holds one one-column
   * cell per UTF-16 unit, from `col` on (hooks/cells.ts `packCells`; the module unpacks it).
   */
  rows: [number, string, number, number, number][][]
  /** The cells that react to the pointer: `[row, col, width, which]`; row 0 only, the marker and the turn number (`which` is 0). */
  press: [number, number, number, number][]
  /** The cells the outline light travels, as `[row, col]` in travel order. */
  outline: [number, number][]
  /** True when the outline closes on itself (a card, a zebra band). */
  cyclic: boolean
  level: Motion
  /** The light's color (`0xRRGGBB`). */
  glint: number
  /** The text's hover colors (`0xRRGGBB`): the first tints the marker and the number; the second is no longer read. */
  tint: [number, number]
  /** Present while a fold or an unfold is recent: the header animates itself from `rows`. */
  fx?: FoldFx
}

export type FolderClientProps = FolderHeadProps

/**
 * One logical line of a message for the shimmer: `prefix` is drawn before the first wrapped line (a list marker, a quote
 * bar, a code indent); `indent` is how many spaces each continuation line starts with; run flags are 1 bold, 2 italic. A
 * `rule` line has no runs and draws `─` across the wrap width.
 */
export type ShineLine = { kind: 'text' | 'rule'; prefix: string; indent: number; runs: [text: string, flags: number][] }

/** What the shimmer's surface module (`hooks/shineClient.tsx`) is handed for a message. Plain data only. */
export type FolderShineProps = {
  kind: 'shine'
  turnId: string
  /** Ms since the shimmer started, at the hook's draw. */
  age: number
  /** The region's width in cells. */
  cols: number
  /** Draw `● ` first (the row's `isFirstOfReply`). */
  bullet: boolean
  lines: ShineLine[]
  /** The reply's rest color (`0xRRGGBB`). */
  text: number
  /** The tint (`0xRRGGBB`). */
  base: number
  /** The highlight (`0xRRGGBB`). */
  peak: number
  /** The highlight's strength, 0..1. */
  strength: number
}

declare module 'claude-code' {
  interface PluginState {
    claudefolder: {
      /** By turnId. */
      turn: StateFamily<FolderTurn>
      /** By row requestId (a row uuid or a tool_use_id): the turnId the row belongs to. */
      row: StateFamily<string>
      /** The main-loop turnIds of this session, oldest first. */
      order: string[]
      /** The background agents pending a task notification, and the count at the newest duration line: kept across a reload. */
      agents: { pending: string[]; last: number }
      /** True while `/folder focus` is on for this session. */
      focus: boolean
    }
  }
}
