import type { FolderShineProps, ShineLine, Shimmer } from '../types'
import type { Palette } from './cells'
import { SHINE_MAX_CHARS, SHINE_MAX_LINES, SHINE_STRENGTH } from './motion'

type Run = [text: string, flags: number]

const BOLD = 1
const ITALIC = 2
/** The characters a backslash may escape. */
const ESCAPABLE = '\\`*_[]()#+-.!|'

const isAlnum = (ch: string): boolean => ch !== '' && /[\p{L}\p{N}]/u.test(ch)

/** `s` with every tab turned into two spaces. */
const untab = (s: string): string => s.replace(/\t/g, '  ')

/** True when a `_` after position `from` closes an emphasis: the character after it is not a letter or a digit. */
function hasUnderscoreCloser(s: string, from: number): boolean {
  for (let j = s.indexOf('_', from); j !== -1; j = s.indexOf('_', j + 1)) {
    if (!isAlnum(s.charAt(j + 1))) return true
  }

  return false
}

/**
 * One line of markdown text as runs of equal flags (1 bold, 2 italic): the marks are taken out and set the flags, links keep
 * their label, code keeps its content, a backslash makes the next mark literal, and a mark with no closer stays as it is.
 */
function inline(s: string): Run[] {
  const chars: { ch: string; flags: number }[] = []
  let boldMark: '**' | '__' | null = null
  let italicMark: '*' | '_' | null = null
  const flags = (): number => (boldMark === null ? 0 : BOLD) | (italicMark === null ? 0 : ITALIC)
  const emit = (text: string): void => {
    const f = flags()
    for (const ch of text) chars.push({ ch, flags: f })
  }
  let i = 0
  while (i < s.length) {
    const c = s.charAt(i)
    const two = s.slice(i, i + 2)
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.includes(s.charAt(i + 1))) {
      emit(s.charAt(i + 1))
      i += 2
      continue
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1)
      if (j !== -1) {
        emit(s.slice(i + 1, j))
        i = j + 1
        continue
      }
      emit(c)
      i++
      continue
    }
    if (c === '[' || (c === '!' && s.charAt(i + 1) === '[')) {
      const link = /!?\[([^\]]*)\]\(([^)]*)\)/y
      link.lastIndex = i
      const m = link.exec(s)
      if (m !== null) {
        emit(m[1] ?? '')
        i += m[0].length
        continue
      }
    }
    if (two === '**' || two === '__') {
      if (boldMark === two) {
        boldMark = null
        i += 2
        continue
      }
      if (boldMark === null && s.indexOf(two, i + 2) !== -1) {
        boldMark = two
        i += 2
        continue
      }
      emit(two)
      i += 2
      continue
    }
    if (c === '*') {
      if (italicMark === '*') {
        italicMark = null
        i++
        continue
      }
      if (italicMark === null && s.indexOf('*', i + 1) !== -1) {
        italicMark = '*'
        i++
        continue
      }
      emit(c)
      i++
      continue
    }
    if (c === '_') {
      if (italicMark === '_' && !isAlnum(s.charAt(i + 1))) {
        italicMark = null
        i++
        continue
      }
      if (italicMark === null && !isAlnum(s.charAt(i - 1)) && hasUnderscoreCloser(s, i + 1)) {
        italicMark = '_'
        i++
        continue
      }
      emit(c)
      i++
      continue
    }
    emit(c)
    i++
  }
  const runs: Run[] = []
  for (const { ch, flags: f } of chars) {
    const prev = runs[runs.length - 1]
    if (prev !== undefined && prev[1] === f) prev[0] += ch
    else runs.push([ch, f])
  }

  return runs
}

const line = (prefix: string, runs: Run[]): ShineLine => ({ kind: 'text', prefix, indent: prefix.length, runs })

/**
 * A message's markdown as the lines the shimmer draws: headings bold, list markers and quote bars as prefixes, code as plain
 * indented lines (no inline parsing), tables as their raw `|` lines, rules as a rule line; blank lines collapse into one.
 */
export function shineLines(markdown: string): ShineLine[] {
  const out: ShineLine[] = []
  let code = false
  let lastBlank = false
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      code = !code
      continue
    }
    if (code) {
      const body = untab(raw)
      out.push({ kind: 'text', prefix: '  ', indent: 2, runs: body === '' ? [] : [[body, 0]] })
      lastBlank = false
      continue
    }
    if (raw.trim() === '') {
      if (out.length > 0 && !lastBlank) out.push({ kind: 'text', prefix: '', indent: 0, runs: [] })
      lastBlank = true
      continue
    }
    lastBlank = false
    const trimmed = raw.trimEnd()
    if (raw.trim().startsWith('|')) {
      out.push({ kind: 'text', prefix: '', indent: 0, runs: [[trimmed, 0]] })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push({ kind: 'rule', prefix: '', indent: 0, runs: [] })
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      out.push({ kind: 'text', prefix: '', indent: 0, runs: inline(heading[1] ?? '').map((r): Run => [r[0], r[1] | BOLD]) })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(trimmed)
    if (quote !== null) {
      out.push({ kind: 'text', prefix: '│ ', indent: 2, runs: inline(quote[1] ?? '') })
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(trimmed)
    if (bullet !== null) {
      out.push(line(untab(bullet[1] ?? '') + '- ', inline(bullet[2] ?? '')))
      continue
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(trimmed)
    if (numbered !== null) {
      out.push(line(untab(numbered[1] ?? '') + (numbered[2] ?? '') + '. ', inline(numbered[3] ?? '')))
      continue
    }
    out.push({ kind: 'text', prefix: '', indent: 0, runs: inline(trimmed) })
  }
  // A trailing blank line is dropped.
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === 'text' && last.prefix === '' && last.runs.length === 0) out.pop()
    else break
  }

  return out
}

/** True when a message is small enough for the shimmer to draw: within the character and line limits. */
export function shineFits(text: string): boolean {
  return text.length <= SHINE_MAX_CHARS && text.split('\n').length <= SHINE_MAX_LINES
}

/** The Client props of a shimmer at `age` ms: the message's lines and the colors of the preset in the motion's strength. */
export function shineProps(input: {
  turnId: string
  text: string
  bullet: boolean
  age: number
  cols: number
  palette: Palette
  shimmer: Exclude<Shimmer, 'off'>
  motion: 'lively' | 'subtle'
}): FolderShineProps {
  const { base, peak } = input.palette.shimmers[input.shimmer]

  return {
    kind: 'shine',
    turnId: input.turnId,
    age: input.age,
    cols: input.cols,
    bullet: input.bullet,
    lines: shineLines(input.text),
    text: input.palette.text,
    base,
    peak,
    strength: SHINE_STRENGTH[input.motion],
  }
}
