import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { FolderClientProps, FolderHeadProps } from '../types'

// A surface module: it runs on the drawing thread with no `$` and none of the plugin's modules, so it imports types only
// and carries its own small color helpers (the same formulas as hooks/cells.ts and hooks/motion.ts).
// One module, the header only: the rows of a turn's header, the pointer, its own outline light and the fold effect.
// One shimmer per action: a fold or an unfold plays the marker flip and one lap of the outline light (from the props, so it
// survives the new instance a toggle mounts); pointing at the marker and number plays one lap on entry, never a loop.
// Only the marker and the number react: `props.press` holds that one range, in the same cells folded and open.

/** The light's frame clock, as the plugin's own (20 fps). */
const FRAME_MS = 50
/** The light's peak over the outline, by motion level. */
const PEAK = { lively: 0.7, subtle: 0.35 }
/** Cells of an outline keyed as `row * ROW_KEY + col`. */
const ROW_KEY = 10_000
/** Frames of the marker's flip. */
const FX_FRAMES = 8
/** Flag 8 on a cell of `props.rows`: a run of one-column cells, one per UTF-16 unit of its text, from its column on (hooks/cells.ts packs them). */
const RUN_FLAG = 8

/** A light running along the outline: its frame in the lap, and what started it (the pointer reaching the text). */
type Light = { f: number; mode: 'hover' }

/**
 * `hover` and `down` are indexes into `press` (-1 for none); `light` is the header's own hover light, when one runs;
 * `armed` is true once the pointer has been seen outside the text, so that its next arrival counts as an entry (a new
 * instance starts unarmed: the pointer a click left on the text did not enter it); `n` counts the redraws a clock tick asked for.
 */
type State = { hover: number; down: number; light: Light | null; armed: boolean; n: number }

type Surface = ClientSurface<State>

type Rows = FolderHeadProps['rows']

const INITIAL: State = { hover: -1, down: -1, light: null, armed: false, n: 0 }

/** The latest props and state of each instance: the listeners registered on the first call read these, not what they closed over. */
const latest = new WeakMap<object, FolderClientProps>()
const mirror = new WeakMap<object, State>()
const started = new WeakSet<object>()
/** The frames each instance has counted since its timing props last changed (`ticksOf`). */
const clocks = new WeakMap<object, { key: string; ticks: number }>()
/** The stop function of each instance's frame clock while it runs: only while an effect or a light has frames left. */
const timers = new WeakMap<object, () => void>()
/** The rows of each props value as one cell per column, unpacked once. */
const unpacked = new WeakMap<object, Rows>()

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

/** `#rrggbb` for Text; undefined for the default color (-1). */
const hex = (n: number): string | undefined => (n < 0 ? undefined : '#' + (n & 0xffffff).toString(16).padStart(6, '0'))

/** Frames in one lap of the light round an outline of `P` cells: about 3 cells per frame, 8 to 40. */
export const lapOf = (P: number): number => clamp(Math.ceil(P / 3), 8, 40)

/**
 * The rows with every run (flag 8) unpacked into one cell per UTF-16 unit, the column counting up from the run's; the
 * same array when nothing is packed.
 */
export function cellsOf(rows: Rows): Rows {
  const done = unpacked.get(rows)
  if (done !== undefined) return done
  const packed = rows.some(row => row.some(c => (c[4] & RUN_FLAG) !== 0))
  const out: Rows = !packed
    ? rows
    : rows.map(row =>
        row.flatMap((c): Rows[number] =>
          (c[4] & RUN_FLAG) === 0 ? [c] : Array.from({ length: c[1].length }, (_, i): Rows[number][number] => [c[0] + i, c[1].charAt(i), c[2], c[3], c[4] & ~RUN_FLAG]),
        ),
      )
  unpacked.set(rows, out)

  return out
}

// ---- the fold effect ---------------------------------------------------------------------------

/** The frame of a fold effect `ticks` frames after its props arrived. */
const frameOf = (fx: NonNullable<FolderHeadProps['fx']>, ticks: number): number => Math.floor((fx.age + FRAME_MS * ticks) / FRAME_MS)

/**
 * The header's cells at frame `f` of its fold effect, from the rest cells in `props.rows`. Only the marker changes: it
 * flips (the other glyph for two frames, then the rest glyph, gold fading out). The lap of light is drawn over the outline
 * by `head`. Nothing is blanked and no background changes: every frame is a complete header.
 */
export function fxCells(props: FolderHeadProps, f: number): Rows {
  const fx = props.fx
  if (fx === undefined || f < 0 || f >= FX_FRAMES) return props.rows
  const [markerRow, markerCol, restCp, restFg, otherCp, otherFg] = fx.marker

  return cellsOf(props.rows).map((cells, r) =>
    r !== markerRow
      ? cells
      : cells.map((cell): Rows[number][number] => {
          const [col, , , bg, flags] = cell
          if (col !== markerCol) return cell
          const other = f < 2
          const amount = f < 4 ? fx.flash : (fx.flash * (FX_FRAMES - f)) / 4

          return [col, String.fromCodePoint(other ? otherCp : restCp), mix(other ? otherFg : restFg, fx.gold, amount), bg, flags]
        }),
  )
}

// ---- the instance's clock and state ------------------------------------------------------------

const stateOf = (surface: Surface): State => mirror.get(surface) ?? surface.state ?? INITIAL

function commit(surface: Surface, next: State): void {
  mirror.set(surface, next)
  surface.setState(next)
}

/**
 * The frames this instance has counted since its timing props last changed: the plugin hands a light's or an effect's age
 * at its draw, and the instance adds 50 ms for each tick it has run since. A new `key` starts the count again.
 */
function ticksOf(surface: Surface, key: string): number {
  const c = clocks.get(surface)
  if (c === undefined || c.key !== key) {
    clocks.set(surface, { key, ticks: 0 })

    return 0
  }

  return c.ticks
}

/** Starts the instance's frame clock, unless it runs. */
function startClock(surface: Surface): void {
  if (timers.has(surface)) return
  timers.set(
    surface,
    surface.every(FRAME_MS, () => onTick(surface)),
  )
}

/** Stops the instance's frame clock: nothing moves until an effect or a light starts it again. */
function stopClock(surface: Surface): void {
  const stop = timers.get(surface)
  if (stop === undefined) return
  timers.delete(surface)
  stop()
}

function tickUp(surface: Surface): void {
  const c = clocks.get(surface)
  if (c !== undefined) c.ticks += 1
}

const headKey = (props: FolderHeadProps): string => (props.fx === undefined ? '' : props.fx.kind + props.fx.age)

// ---- the header --------------------------------------------------------------------------------

/** The index of the `press` entry under (`x`, `y`), or -1. */
function hit(props: FolderHeadProps, x: number, y: number): number {
  return props.press.findIndex(([row, col, width]) => row === y && x >= col && x < col + width)
}

/** The frame of the lap a fold or an unfold plays, `ticks` frames after the props arrived; null when there is none (no effect, or motion off). */
const toggleFrame = (props: FolderHeadProps, ticks: number): number | null =>
  props.fx === undefined || props.level === 'off' ? null : frameOf(props.fx, ticks)

/** True while the lap of a fold or an unfold is running. */
function toggleActive(props: FolderHeadProps, ticks: number): boolean {
  const f = toggleFrame(props, ticks)

  return f !== null && f < lapOf(props.outline.length)
}

function onPointer(surface: Surface, e: ClientPointerEvent): void {
  const props = latest.get(surface)
  if (props === undefined || props.kind !== 'head') return
  const s = stateOf(surface)
  if (e.type === 'leave') {
    if (s.hover !== -1 || !s.armed) commit(surface, { ...s, hover: -1, armed: true })

    return
  }
  if (e.type === 'move' || e.type === 'enter') {
    const h = hit(props, e.x, e.y)
    if (h === -1) {
      // Seen outside the text: the next arrival on it counts as an entry.
      if (s.hover !== -1 || !s.armed) commit(surface, { ...s, hover: -1, armed: true })

      return
    }
    // One lap on entry only: not while one runs, not while a fold's or an unfold's lap runs, not for a pointer a click left there.
    const entered = s.armed && s.hover === -1
    let next: State = { ...s, hover: h, armed: false }
    if (entered && props.level === 'lively' && s.light === null && !toggleActive(props, ticksOf(surface, headKey(props)))) {
      next = { ...next, light: { f: 0, mode: 'hover' } }
    }
    if (next.hover !== s.hover || next.armed !== s.armed || next.light !== s.light) commit(surface, next)
    if (next.light !== null) startClock(surface)

    return
  }
  if (e.type === 'down') {
    if (e.button !== 'left') return
    const d = hit(props, e.x, e.y)
    if (d !== s.down) commit(surface, { ...s, down: d })

    return
  }
  if (s.down === -1) return
  // A press released inside the text it went down on toggles the turn; the header that replaces this one plays the lap.
  if (hit(props, e.x, e.y) === s.down) surface.post({ type: 'toggle', turnId: props.turnId })
  commit(surface, { ...s, down: -1 })
}

/** True while the header has frames to draw that differ from the last: a fold effect before the end of its flip and its lap. */
function headRunning(props: FolderHeadProps, ticks: number): boolean {
  return props.fx !== undefined && frameOf(props.fx, ticks) < Math.max(FX_FRAMES, lapOf(props.outline.length))
}

/** One frame: the header's own hover light moves on (at the end of its lap it ends, never restarts), and an effect advances. */
function headTick(surface: Surface, props: FolderHeadProps): void {
  const s = stateOf(surface)
  let next = s
  if (s.light !== null) {
    const f = s.light.f + 1
    // A fold's or an unfold's lap takes over from a hover light.
    if (f < lapOf(props.outline.length) && !toggleActive(props, ticksOf(surface, headKey(props)))) next = { ...s, light: { f, mode: s.light.mode } }
    else next = { ...s, light: null }
  }
  const running = headRunning(props, ticksOf(surface, headKey(props)))
  if (running) tickUp(surface)
  if (next !== s || running) commit(surface, { ...next, n: next.n + 1 })
  // At rest (no effect frames left, no light): the clock stops until the next effect or light.
  if (!running && next.light === null) stopClock(surface)
}

/** How lit each outline cell is at the light's frame, by `row * ROW_KEY + col`; cells the light is not over are left out. */
function lightOf(props: FolderHeadProps, light: Light): Map<number, number> {
  const out = new Map<number, number>()
  const P = props.outline.length
  if (P === 0 || props.level === 'off') return out
  const L = lapOf(P)
  const hw = Math.min(3, Math.max(1, P / 4))
  const peak = PEAK[props.level]
  props.outline.forEach(([row, col], i) => {
    let d: number
    if (props.cyclic) {
      const raw = Math.abs(i - (P * light.f) / L)
      d = Math.min(raw, P - raw)
    } else {
      d = Math.abs(i - (-hw + ((P - 1 + 2 * hw) * light.f) / L))
    }
    if (d < hw) out.set(row * ROW_KEY + col, (peak * (1 + Math.cos((Math.PI * d) / hw))) / 2)
  })

  return out
}

/** The header: its rows as the plugin composed them (the marker's flip drawn over them), the pressable text tinted while hovered, the outline lit while a light runs. */
const head: ClientModule<FolderHeadProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const s = stateOf(surface)
  const ticks = ticksOf(surface, headKey(props))
  const rows = cellsOf(props.fx === undefined ? props.rows : fxCells(props, frameOf(props.fx, ticks)))
  // One light at a time: a fold's or an unfold's lap when it runs, else the hover lap.
  const lap = toggleActive(props, ticks) ? toggleFrame(props, ticks) : null
  const light: Light | null = lap !== null ? { f: lap, mode: 'hover' } : s.light
  const lit = light === null ? new Map<number, number>() : lightOf(props, light)
  const tinted = (row: number, col: number): number | null => {
    if (s.hover === -1) return null
    for (const [r, c, width, which] of props.press) {
      if (r === row && col >= c && col < c + width) return props.tint[which === 1 ? 1 : 0]
    }

    return null
  }

  return (
    <Box flexDirection="column">
      {rows.map((cells, row) => {
        const runs: { text: string; fg: number; bg: number; flags: number }[] = []
        for (const [col, text, fg0, bg, flags0] of cells) {
          let fg = fg0
          let flags = flags0 & 3
          const amount = lit.get(row * ROW_KEY + col)
          if (amount !== undefined && fg >= 0) fg = mix(fg, props.glint, amount)
          const tint = tinted(row, col)
          if (tint !== null) {
            fg = tint
            flags &= ~2
          }
          const prev = runs[runs.length - 1]
          if (prev !== undefined && prev.fg === fg && prev.bg === bg && prev.flags === flags) prev.text += text
          else runs.push({ text, fg, bg, flags })
        }

        return (
          <Text wrap="truncate-end">
            {runs.map(r => (
              <Text color={hex(r.fg)} backgroundColor={hex(r.bg)} bold={(r.flags & 1) !== 0 ? true : undefined} dimColor={(r.flags & 2) !== 0 ? true : undefined}>
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

function onTick(surface: Surface): void {
  const props = latest.get(surface)
  if (props === undefined) return
  if (props.kind === 'head') headTick(surface, props)
}

const client: ClientModule<FolderClientProps, State> = (props, surface) => {
  latest.set(surface, props)
  if (!started.has(surface)) {
    started.add(surface)
    surface.setState(INITIAL)
    surface.onPointer(e => onPointer(surface, e))
  }
  // The clock runs only while there is something to move: new props with an effect that has frames left start it.
  if (props.kind === 'head' && headRunning(props, ticksOf(surface, headKey(props)))) startClock(surface)
  if (props.kind === 'head') return head(props, surface)

  // Test seam: the plugin answers a post with props of no kind, so the module fails for real (`ui.fault`).
  throw new Error('claudefolder: unknown surface kind')
}

export default client
