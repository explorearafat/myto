import { describe, expect, it } from 'vitest'
import { threadCards } from '@renderer/lib/threadCards'
import type { ToolCardUI } from '@renderer/store/useChatStore'
import type { ReadProposal, ReadResult, ToolProposal, ToolResult } from '@shared/types'

/**
 * What the chat thread is allowed to show.
 *
 * The rule under test is a judgement about noise, so both halves of it matter and
 * each is asserted on its own: a read that worked leaves no row behind (the status
 * line already said `Reading X` while it happened, and the answer is what the user
 * came for), while a read that failed still speaks up, because that is work that
 * did NOT happen and the transcript has to be honest about it.
 */
const card = (over: Partial<ToolCardUI> & { proposal: ToolProposal }): ToolCardUI => ({
  id: 'tool-1',
  runId: 'run-1',
  afterMessageId: 'msg-1',
  auto: true,
  status: 'complete',
  ...over
})

const readOf = (path: string): ReadProposal => ({
  id: 'tool-1',
  kind: 'read',
  op: 'read_file',
  path
})

const readResult = (over: Partial<ReadResult> = {}): ToolResult => ({
  id: 'tool-1',
  kind: 'read',
  ok: true,
  output: 'export const a = 1\n',
  truncated: false,
  summary: '105 lines',
  ...over
})

const read = (path: string, result?: ToolResult): ToolCardUI =>
  card({ proposal: readOf(path), result })

const write = (path: string): ToolCardUI =>
  card({
    proposal: {
      id: 'tool-w',
      kind: 'write_file',
      path,
      newContent: 'next',
      oldContent: 'prev',
      exists: true
    }
  })

const command = (cmd: string): ToolCardUI =>
  card({ proposal: { id: 'tool-c', kind: 'run_command', command: cmd } })

describe('threadCards', () => {
  it('drops a read that went fine', () => {
    expect(threadCards([read('tailwind.config.js', readResult())])).toEqual([])
  })

  it('drops a read still in flight, rather than flashing a row that then vanishes', () => {
    expect(threadCards([read('globals.css')])).toEqual([])
  })

  it('keeps a read that failed — that is not noise, it is work that did not happen', () => {
    const missing = read('nope.ts', readResult({ ok: false, error: 'ENOENT', summary: '' }))
    expect(threadCards([missing])).toEqual([missing])
  })

  it('keeps every other kind of op, which is the actual work', () => {
    const cards = [write('src/App.tsx'), command('npm test')]
    expect(threadCards(cards)).toEqual(cards)
  })

  it('leaves the surviving cards in stream order', () => {
    const before = write('src/a.ts')
    const after = command('npm run build')
    const cards = [
      read('FILEMAP.md', readResult()),
      before,
      read('STATE.md', readResult()),
      after,
      read('cn.ts', readResult())
    ]
    expect(threadCards(cards)).toEqual([before, after])
  })

  it('hides the whole gathering pass — eight reads leave nothing behind', () => {
    // The turn the user pinned this on: eight files read up front, eight rows.
    const gathered = [
      'tailwind.config.js',
      'globals.css',
      'cn.ts',
      'App.tsx',
      'index.html',
      'package.json',
      'FILEMAP.md',
      'STATE.md'
    ].map((p) => read(p, readResult()))

    expect(threadCards(gathered)).toEqual([])
  })
})
