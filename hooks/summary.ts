import type { FolderTurn } from '../types'
import { displayWidth } from './cells'

/** The longest title or reply kept, in code points. */
const TEXT_MAX = 200
/** The separator between the parts of a stats text, and between the reply and the stats. */
export const SEP = ' · '
/** The tools that edit a file, and so name it in the stats. */
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

const cutCodePoints = (s: string, max: number): string => {
  const all = Array.from(s)

  return all.length <= max ? s : all.slice(0, max).join('')
}

/** The turn's title: a command's `/name args`, else the prompt's first non-blank line on one line; `(continued)` when there is none. */
export function titleOf(text: string, command: string | null): string {
  if (command !== null) return cutCodePoints(command, TEXT_MAX)
  const line = text.split(/\r?\n/).find(l => l.trim() !== '')
  if (line === undefined) return '(continued)'

  return cutCodePoints(line.replace(/\s+/g, ' ').trim(), TEXT_MAX)
}

/** `text` with every `<...>` tag removed and the whitespace collapsed: a notification's markup gives way to its words. */
export function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/** The first line of the answer that still has text once the markdown marks are gone; '' when there is none. */
export function replyOf(answer: string): string {
  for (const raw of answer.split(/\r?\n/)) {
    let line = raw.trim()
    let before = ''
    while (before !== line) {
      before = line
      line = line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, '')
    }
    line = line.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
    if (line !== '') return cutCodePoints(line, TEXT_MAX)
  }

  return ''
}

/** The basename of the file an edit tool names, or null for any other tool or an input without a path. */
export function fileOf(tool: string, input: unknown): string | null {
  if (!EDIT_TOOLS.includes(tool) || input === null || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const path = typeof o.file_path === 'string' ? o.file_path : typeof o.notebook_path === 'string' ? o.notebook_path : null
  if (path === null) return null
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

  return name === '' ? null : name
}

/** `41s`, `1m 4s`, `1h 2m`; never under `1s`. */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (s < 3600) return `${m}m ${s % 60}s`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** One piece of the stats text; `isFail` marks the words of an interrupted or failed turn. */
export type StatPart = { text: string; isFail: boolean }

/**
 * The stats of a finished turn, in order: tools, edited files, duration (unless `withDuration` is false), then `interrupted`
 * or `error`. The files are named when there are one or two; more are counted (`edited 3 files`), unless `listFiles` is
 * true, which names every one (`edited a.ts, b.ts, c.ts`).
 */
export function statsParts(
  turn: Pick<FolderTurn, 'tools' | 'files' | 'durationMs' | 'status'>,
  withDuration = true,
  listFiles = false,
): StatPart[] {
  const parts: StatPart[] = []
  if (turn.tools > 0) parts.push({ text: turn.tools === 1 ? '1 tool' : `${turn.tools} tools`, isFail: false })
  if (listFiles && turn.files.length > 0) parts.push({ text: `edited ${turn.files.join(', ')}`, isFail: false })
  else if (turn.files.length === 1 || turn.files.length === 2) parts.push({ text: `edited ${turn.files.join(', ')}`, isFail: false })
  else if (turn.files.length > 2) parts.push({ text: `edited ${turn.files.length} files`, isFail: false })
  if (withDuration && turn.durationMs !== null) parts.push({ text: formatDuration(turn.durationMs), isFail: false })
  if (turn.status === 'interrupted') parts.push({ text: 'interrupted', isFail: true })
  else if (turn.status === 'error') parts.push({ text: 'error', isFail: true })

  return parts
}

/** `s` when it fits `width` cells, else its longest prefix that leaves room for a closing `…`. */
export function cutTo(s: string, width: number): string {
  if (displayWidth(s) <= width) return s
  if (width < 1) return ''
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = displayWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }

  return out + '…'
}
