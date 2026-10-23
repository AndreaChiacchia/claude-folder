import type { ClientModule, ClientSurface } from 'claude-code'

import type { FolderShineProps, ShineLine } from '../types'

// A surface module: it runs on the drawing thread with no `$` and none of the plugin's modules, so it imports types only
// and carries its own small helpers (the same formulas as hooks/cells.ts), as headerClient.tsx does.
// It draws the last message of a turn while it shimmers: the plugin hands the message as lines, the colors and how long ago
// the shimmer started; this module wraps the lines to its region, tints them and glows them once (one color for the whole message at each frame), on its own clock.
// No pointer and no posts: the plugin ends the shimmer by drawing the engine's own row again.

/** The frame clock, as the plugin's own (20 fps). */
export const FRAME_MS = 50
/** The shimmer's length (ms); the same numbers as motion.ts's `SHINE_*` (a test checks it). */
export const TOTAL = 3700
export const FADE_IN = 300
export const RISE = 900
export const FALL = 1500
export const FADE_OUT = 500

/** `n` counts the redraws a clock tick asked for. */
type State = { n: number }

type Surface = ClientSurface<State>

/** One character of a screen line: where it starts (cells from the region's left edge) and its flags (1 bold, 2 italic). */
export type ShineCell = { ch: string; col: number; flags: number }

const INITIAL: State = { n: 0 }

const latest = new WeakMap<object, FolderShineProps>()
const mirror = new WeakMap<object, State>()
const started = new WeakSet<object>()
/** The frames each instance has counted since its `age` last changed. */
const clocks = new WeakMap<object, { key: string; ticks: number }>()
const timers = new WeakMap<object, () => void>()
/** The color each instance last drew. */
const painted = new WeakMap<object, number>()

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** `a` blended into `b` by `t` (0..1), per channel. */
export function mix(a: number, b: number, t: number): number {
  const channel = (shift: number): number => {
    const ca = (a >> shift) & 0xff
    const cb = (b >> shift) & 0xff

    return Math.round(ca + (cb - ca) * t)
  }

  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

/** `#rrggbb` for Text. */
const hex = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0')

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6)

/** How many terminal cells `s` takes: 0 for combining marks, zero-width spaces and variation selectors, 2 for wide letters and anything beyond the BMP, else 1. */
export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    width += isWide(cp) || cp > 0xffff ? 2 : 1
  }

  return width
}

// ---- the layout --------------------------------------------------------------------------------

/**
 * The lines wrapped to a region `width` cells wide, as screen lines of characters with their columns. The text starts at
 * column 2 on every screen line (columns 0 and 1 hold the bullet or spaces) and takes `width - 2` cells. A logical line
 * starts with its `prefix` and wraps at spaces, its continuations starting with `indent` spaces; a word longer than the room
 * breaks at the width. A rule is `─` across the room; an empty line is one empty screen line.
 */
export function wrapShine(lines: ShineLine[], width: number): ShineCell[][] {
  const room = Math.max(1, width - 2)
  const screen: ShineCell[][] = []
  for (const l of lines) {
    if (l.kind === 'rule') {
      screen.push(Array.from({ length: room }, (_, i): ShineCell => ({ ch: '─', col: 2 + i, flags: 0 })))
      continue
    }
    let cur: ShineCell[] = []
    let used = 0
    // What the line holds before its text: the prefix on the first screen line, the indent on a continuation.
    let lead = 0
    const put = (ch: string, flags: number): void => {
      const w = displayWidth(ch)
      if (used + w > room && used > lead) newLine()
      cur.push({ ch, col: 2 + used, flags })
      used += w
    }
    const newLine = (): void => {
      screen.push(cur)
      cur = []
      used = 0
      lead = 0
      for (let i = 0; i < l.indent && i < room - 1; i++) {
        cur.push({ ch: ' ', col: 2 + used, flags: 0 })
        used++
      }
      lead = used
    }
    for (const ch of l.prefix) put(ch, 0)
    lead = used
    // The text as words and the spaces between them.
    const chars: { ch: string; flags: number }[] = []
    for (const [text, flags] of l.runs) for (const ch of text) chars.push({ ch: ch === '\t' ? ' ' : ch, flags })
    let i = 0
    while (i < chars.length) {
      const isSpace = chars[i]?.ch === ' '
      let j = i
      while (j < chars.length && (chars[j]?.ch === ' ') === isSpace) j++
      const token = chars.slice(i, j)
      if (isSpace) {
        for (const c of token) {
          if (used + 1 > room) {
            // A separator at a break is dropped.
            newLine()
            break
          }
          put(c.ch, c.flags)
        }
      } else {
        const w = token.reduce((sum, c) => sum + displayWidth(c.ch), 0)
        if (used + w > room && used > lead) newLine()
        for (const c of token) put(c.ch, c.flags)
      }
      i = j
    }
    screen.push(cur)
  }

  return screen
}

// ---- the colors --------------------------------------------------------------------------------

/** Eased in and out: 0 at 0, ½ at ½, 1 at 1. */
export const ease = (x: number): number => (1 - Math.cos(Math.PI * clamp(x, 0, 1))) / 2

/** The glow at `t` ms since it started: how far the tint is in (0..1) and how bright the glow is (0..1, 1 at the highlight). */
export function shineAmount(t: number): { tint: number; glow: number } {
  const at = Math.max(0, t)
  const peakAt = FADE_IN + RISE
  const glowEnd = peakAt + FALL
  const fadeAt = TOTAL - FADE_OUT
  let tint: number
  if (at < FADE_IN) tint = ease(at / FADE_IN)
  else if (at < fadeAt) tint = 1
  else if (at < TOTAL) tint = ease((TOTAL - at) / FADE_OUT)
  else tint = 0
  let glow = 0
  if (at >= FADE_IN && at < peakAt) glow = ease((at - FADE_IN) / RISE)
  else if (at >= peakAt && at < glowEnd) glow = ease((glowEnd - at) / FALL)

  return { tint, glow }
}

/**
 * The whole message's color at a frame: the text color tinted toward the preset's base, lifted toward its highlight by the
 * glow (sixteenths, so the colors step and repaints stay few).
 */
export function shineColor(a: ReturnType<typeof shineAmount>, props: FolderShineProps): number {
  const s = (x: number): number => Math.round(x * 16) / 16

  return mix(mix(props.text, props.base, s(a.tint)), props.peak, s(props.strength * a.glow))
}

// ---- the instance's clock ----------------------------------------------------------------------

const stateOf = (surface: Surface): State => mirror.get(surface) ?? surface.state ?? INITIAL

function commit(surface: Surface, next: State): void {
  mirror.set(surface, next)
  surface.setState(next)
}

/** The frames this instance has counted since its `age` last changed: a new `key` starts the count again. */
function ticksOf(surface: Surface, key: string): number {
  const c = clocks.get(surface)
  if (c === undefined || c.key !== key) {
    clocks.set(surface, { key, ticks: 0 })

    return 0
  }

  return c.ticks
}

function stopClock(surface: Surface): void {
  const stop = timers.get(surface)
  if (stop === undefined) return
  timers.delete(surface)
  stop()
}

function startClock(surface: Surface): void {
  if (timers.has(surface)) return
  timers.set(
    surface,
    surface.every(FRAME_MS, () => onTick(surface)),
  )
}

/** One frame: the glow moves on; a redraw only when its color changed; the clock stops at the end. */
function onTick(surface: Surface): void {
  const props = latest.get(surface)
  if (props === undefined) return
  const key = String(props.age)
  ticksOf(surface, key)
  const c = clocks.get(surface)
  if (c !== undefined) c.ticks += 1
  const t = props.age + FRAME_MS * (c?.ticks ?? 0)
  const color = shineColor(shineAmount(t), props)
  if (color !== painted.get(surface)) commit(surface, { n: stateOf(surface).n + 1 })
  if (t >= TOTAL) stopClock(surface)
}

// ---- the message -------------------------------------------------------------------------------

/** The message at its frame: a column of Text lines, each of runs of one color and style. */
const shine: ClientModule<FolderShineProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const t = props.age + FRAME_MS * ticksOf(surface, String(props.age))
  const screen = wrapShine(props.lines, surface.columns > 0 ? surface.columns : props.cols)
  const color = shineColor(shineAmount(t), props)
  painted.set(surface, color)

  return (
    <Box flexDirection="column">
      {screen.map((cells, row) => {
        const runs: { text: string; color: number; flags: number }[] = []
        const push = (text: string, color: number, flags: number): void => {
          const prev = runs[runs.length - 1]
          if (prev !== undefined && prev.color === color && prev.flags === flags) prev.text += text
          else runs.push({ text, color, flags })
        }
        // Columns 0 and 1: the bullet on the first line (when asked), else spaces.
        if (row === 0 && props.bullet) push('●', color, 0)
        else push(' ', color, 0)
        push(' ', color, 0)
        for (const c of cells) push(c.ch, color, c.flags & 3)

        return (
          <Text wrap="truncate-end">
            {runs.map(r => (
              <Text color={hex(r.color)} bold={(r.flags & 1) !== 0 ? true : undefined} italic={(r.flags & 2) !== 0 ? true : undefined}>
                {r.text}
              </Text>
            ))}
          </Text>
        )
      })}
    </Box>
  )
}

// ---- the entry ---------------------------------------------------------------------------------

const client: ClientModule<FolderShineProps, State> = (props, surface) => {
  // Test seam and fault path: props that are not a shimmer's make the module fail for real (`ui.fault`).
  if (props.kind !== 'shine') throw new Error('claudefolder: unknown surface kind')
  latest.set(surface, props)
  if (!started.has(surface)) {
    started.add(surface)
    surface.setState(INITIAL)
  }
  // The clock runs only while the shimmer has frames left.
  if (props.age + FRAME_MS * ticksOf(surface, String(props.age)) < TOTAL) startClock(surface)

  return shine(props, surface)
}

export default client
