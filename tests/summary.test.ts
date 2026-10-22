import { expect, test } from 'claude-code/testing'

import { displayWidth } from '../hooks/cells'
import { cutTo, fileOf, formatDuration, notificationTitleOf, replyOf, statsParts, stripTags, titleOf } from '../hooks/summary'
import type { FolderTurn } from '../types'

const turn = (over: Partial<FolderTurn> = {}): FolderTurn => ({
  n: 7,
  turnId: 't7',
  title: 'fix the login',
  reply: '',
  tools: 0,
  files: [],
  durationMs: null,
  status: 'done',
  folded: true,
  autoFolded: true,
  header: 'u7',
  changedAt: 0,
  closer: null,
  ...over,
})

test('titleOf takes the first non-blank line on one line', () => {
  expect(titleOf('\n  \n  fix the   login\nand more', null)).toBe('fix the login')
  expect(titleOf('one\ttwo', null)).toBe('one two')
})

test('titleOf with no text is (continued), and a command title wins', () => {
  expect(titleOf('', null)).toBe('(continued)')
  expect(titleOf(' \n \t ', null)).toBe('(continued)')
  expect(titleOf('some prompt', '/compact now')).toBe('/compact now')
})

test('stripTags removes the tags and collapses the whitespace', () => {
  expect(stripTags('<task-notification><summary>Agent done</summary></task-notification>')).toBe('Agent done')
  expect(stripTags('  a <b>c</b>\n d ')).toBe('a c d')
  expect(stripTags('<x/>')).toBe('')
})

test('notificationTitleOf reads the summary of a task notification, else its words, and null for other text', () => {
  const full =
    '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Quick test agent" finished</summary>\n</task-notification>'
  expect(notificationTitleOf(full)).toBe('Agent "Quick test agent" finished')
  expect(notificationTitleOf('<task-notification><task-id>a</task-id><status>completed</status>All done.</task-notification>')).toBe('All done.')
  expect(notificationTitleOf('fix the login')).toBeNull()
})

test('titleOf cuts to 200 code points', () => {
  expect(Array.from(titleOf('a'.repeat(300), null)).length).toBe(200)
  expect(Array.from(titleOf('😀'.repeat(300), null)).length).toBe(200)
})

test('replyOf strips the markdown marks of the first line with text', () => {
  expect(replyOf('# Done\nthe rest')).toBe('Done')
  expect(replyOf('### Deep heading')).toBe('Deep heading')
  expect(replyOf('- fixed it')).toBe('fixed it')
  expect(replyOf('* starred')).toBe('starred')
  expect(replyOf('+ plussed')).toBe('plussed')
  expect(replyOf('1. first step')).toBe('first step')
  expect(replyOf('> quoted words')).toBe('quoted words')
  expect(replyOf('**Fixed** the `bug` and __more__')).toBe('Fixed the bug and more')
})

test('replyOf skips blank leading lines, and has nothing for no text', () => {
  expect(replyOf('\n\n   \nHello   world\nsecond')).toBe('Hello world')
  expect(replyOf('')).toBe('')
  expect(replyOf('  \n  ')).toBe('')
  expect(replyOf('```\n')).toBe('')
  expect(Array.from(replyOf('x'.repeat(500))).length).toBe(200)
})

test('fileOf names the file an edit tool touches', () => {
  expect(fileOf('Edit', { file_path: 'C:\\src\\app\\auth.ts' })).toBe('auth.ts')
  expect(fileOf('Write', { file_path: '/home/me/notes/z.md' })).toBe('z.md')
  expect(fileOf('MultiEdit', { file_path: 'plain.txt' })).toBe('plain.txt')
  expect(fileOf('NotebookEdit', { notebook_path: '/n/a.ipynb' })).toBe('a.ipynb')
})

test('fileOf is null for other tools and for inputs without a path', () => {
  expect(fileOf('Read', { file_path: '/x/y.ts' })).toBeNull()
  expect(fileOf('Bash', { command: 'ls' })).toBeNull()
  expect(fileOf('Edit', null)).toBeNull()
  expect(fileOf('Edit', 'text')).toBeNull()
  expect(fileOf('Edit', { file_path: 5 })).toBeNull()
  expect(fileOf('Edit', { file_path: '/dir/' })).toBeNull()
})

test('formatDuration', () => {
  expect(formatDuration(0)).toBe('1s')
  expect(formatDuration(999)).toBe('1s')
  expect(formatDuration(41_000)).toBe('41s')
  expect(formatDuration(64_000)).toBe('1m 4s')
  expect(formatDuration(3_726_000)).toBe('1h 2m')
})

test('statsParts in order: tools, files, duration, then the failure word', () => {
  const texts = (t: Partial<FolderTurn>) => statsParts(turn(t)).map(p => p.text)
  expect(texts({})).toEqual([])
  expect(texts({ tools: 1 })).toEqual(['1 tool'])
  expect(texts({ tools: 6, files: ['auth.ts', 'login.tsx'], durationMs: 41_000 })).toEqual([
    '6 tools',
    'edited auth.ts, login.tsx',
    '41s',
  ])
  expect(texts({ files: ['a.ts'] })).toEqual(['edited a.ts'])
  expect(texts({ files: ['a.ts', 'b.ts', 'c.ts'] })).toEqual(['edited 3 files'])
  expect(statsParts(turn({ status: 'interrupted', durationMs: 5000 }))).toEqual([
    { text: '5s', isFail: false },
    { text: 'interrupted', isFail: true },
  ])
  expect(statsParts(turn({ status: 'error' }))).toEqual([{ text: 'error', isFail: true }])
})

test('statsParts without the duration leaves the time out', () => {
  const t = turn({ tools: 1, files: ['auth.ts'], durationMs: 41_000 })
  expect(statsParts(t, false).map(p => p.text)).toEqual(['1 tool', 'edited auth.ts'])
  expect(statsParts(t, true).map(p => p.text)).toEqual(['1 tool', 'edited auth.ts', '41s'])
})

test('statsParts with listFiles names every edited file; without it more than two are counted', () => {
  const t = turn({ tools: 3, files: ['a.ts', 'b.ts', 'c.ts'], durationMs: 41_000 })
  expect(statsParts(t, true, true).map(p => p.text)).toEqual(['3 tools', 'edited a.ts, b.ts, c.ts', '41s'])
  expect(statsParts(t).map(p => p.text)).toEqual(['3 tools', 'edited 3 files', '41s'])
  expect(statsParts(t, false, true).map(p => p.text)).toEqual(['3 tools', 'edited a.ts, b.ts, c.ts'])
  // One or two files read the same either way; none stays out.
  expect(statsParts(turn({ files: ['a.ts', 'b.ts'] }), true, true).map(p => p.text)).toEqual(['edited a.ts, b.ts'])
  expect(statsParts(turn({ tools: 1 }), true, true).map(p => p.text)).toEqual(['1 tool'])
})

test('displayWidth counts cells: CJK and emoji two, combining marks none', () => {
  expect(displayWidth('abc')).toBe(3)
  expect(displayWidth('日本')).toBe(4)
  expect(displayWidth('😀')).toBe(2)
  expect(displayWidth('e\u0301')).toBe(1)
  expect(displayWidth('a\u200bb')).toBe(2)
})

test('cutTo keeps what fits and closes a cut with …', () => {
  expect(cutTo('hi', 5)).toBe('hi')
  expect(cutTo('hello world', 8)).toBe('hello w…')
  expect(displayWidth(cutTo('hello world', 8))).toBe(8)
  expect(cutTo('日本語日本語', 7)).toBe('日本語…')
  expect(cutTo('日本語日本語', 8)).toBe('日本語…')
  expect(cutTo('abc', 1)).toBe('…')
  expect(cutTo('abc', 0)).toBe('')
})
