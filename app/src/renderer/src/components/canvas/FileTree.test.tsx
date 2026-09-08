import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileTree } from '@renderer/components/canvas/FileTree'
import { useChatStore, type ToolCardUI } from '@renderer/store/useChatStore'
import { useAppStore } from '@renderer/store/useAppStore'
import type { ToolProposal } from '@shared/types'

/**
 * The tree answers "which files am I about to have to look at", so the assertions
 * are about the fold: one row per file however many ops touched it, a rejected write
 * contributing no +/− (it changed nothing on disk), and only files Sylor really
 * opened — a project-wide search targets '.', and drawing that as a touched file
 * would put a folder in the tree as if it had been read.
 */
function write(path: string, over: Partial<ToolCardUI> = {}, added = 2): ToolCardUI {
  const id = 'w-' + path + (over.id ?? '')
  const extra = Array.from({ length: added }, (_, i) => `new ${i}`).join('\n')
  const proposal: ToolProposal = {
    id,
    kind: 'write_file',
    path,
    oldContent: 'a\nb\n',
    newContent: `a\n${extra}\n`,
    exists: true
  }
  return { id, runId: 'run-1', afterMessageId: 'm-1', proposal, auto: false, status: 'complete', ...over }
}

function read(path: string, op: 'read_file' | 'search_files' = 'read_file'): ToolCardUI {
  const id = 'r-' + op + path
  return {
    id,
    runId: 'run-1',
    afterMessageId: 'm-1',
    proposal: { id, kind: 'read', op, path },
    auto: true,
    status: 'complete'
  }
}

function seed(tools: ToolCardUI[]): void {
  useChatStore.setState({ tools })
}

beforeEach(() => {
  seed([])
  useAppStore.setState({ canvasMode: 'log' })
})

describe('FileTree', () => {
  it('says nothing has been touched rather than showing an empty frame', () => {
    render(<FileTree />)
    expect(screen.getByText('Nothing touched yet.')).toBeTruthy()
  })

  it('counts changed and read separately, and totals the lines', () => {
    seed([write('src/a.ts'), write('src/b.ts'), read('src/c.ts')])
    render(<FileTree />)

    // Read off the header itself: every row carries its own +/− too, so a query on
    // the numbers alone would not say whether the total or a row was found.
    const header = screen.getByText('2 changed, 1 read').parentElement
    expect(header?.textContent).toContain('+4 −2')
  })

  it('marks a read-only file as read instead of giving it line counts', () => {
    seed([read('src/looked-at.ts')])
    render(<FileTree />)

    expect(screen.getByText('read')).toBeTruthy()
    expect(screen.getByTitle('src/looked-at.ts — read, not changed')).toBeTruthy()
  })

  it('ignores a read op that targets a directory rather than a file', () => {
    // `search_files` over '.' is not "Sylor opened this file", and a row for it
    // would claim a folder had been read.
    seed([read('.', 'search_files'), read('src/real.ts')])
    render(<FileTree />)

    expect(screen.getByText('0 changed, 1 read')).toBeTruthy()
    expect(screen.getByTitle('src/real.ts — read, not changed')).toBeTruthy()
  })

  it('folds repeated ops on one file into a single row and says how many', () => {
    seed([write('src/a.ts', { id: '1' }), write('src/a.ts', { id: '2' }), read('src/a.ts')])
    render(<FileTree />)

    expect(screen.getByText('1 changed, 0 read')).toBeTruthy()
    // Three ops, one row — and the tooltip carries the count rather than hiding it.
    expect(screen.getByTitle('src/a.ts — written 3 times this run')).toBeTruthy()
  })

  it('leaves a rejected write out of the line totals but keeps its row', () => {
    seed([write('src/kept.ts'), write('src/turned-down.ts', { decision: 'reject' })])
    render(<FileTree />)

    expect(screen.getByTitle('src/turned-down.ts — you turned this write down')).toBeTruthy()
    // Both files are ones Sylor tried to change, but only the write that landed is
    // counted: +2/−1 for the run, not +4/−2.
    const header = screen.getByText('2 changed, 0 read').parentElement
    expect(header?.textContent).toContain('+2 −1')
  })

  it('says a failed write did not land', () => {
    seed([
      write('src/a.ts', {
        result: { id: 'x', kind: 'write_file', ok: false, error: 'EACCES' }
      })
    ])
    render(<FileTree />)
    expect(screen.getByTitle('src/a.ts — the write did not land')).toBeTruthy()
  })

  it('says a write still awaiting a decision is being written now', () => {
    seed([write('src/a.ts', { status: 'awaiting' })])
    render(<FileTree />)
    expect(screen.getByTitle('src/a.ts — being written now')).toBeTruthy()
  })

  it('collapses a single-child folder chain into one row', () => {
    seed([write('src/renderer/src/components/App.tsx')])
    render(<FileTree />)

    // Four levels of indentation carrying one bit of information becomes one row.
    expect(screen.getByText('src/renderer/src/components')).toBeTruthy()
    expect(screen.getByText('App.tsx')).toBeTruthy()
  })

  it('keeps a branching folder as its own row, sorted by name', () => {
    seed([write('src/main/a.ts'), write('src/renderer/b.ts')])
    render(<FileTree />)

    // `src` has two children now, so it cannot merge into either.
    expect(screen.getByText('src')).toBeTruthy()
    const folders = screen.getAllByText(/^(main|renderer)$/).map((el) => el.textContent)
    expect(folders).toEqual(['main', 'renderer'])
  })

  it('offers the diff only when something was actually written', () => {
    seed([read('src/a.ts')])
    const { unmount } = render(<FileTree />)
    expect(screen.queryByText('see the diff')).toBeNull()
    unmount()

    seed([write('src/a.ts')])
    render(<FileTree />)
    fireEvent.click(screen.getByText('see the diff'))
    expect(useAppStore.getState().canvasMode).toBe('diff')
  })
})
