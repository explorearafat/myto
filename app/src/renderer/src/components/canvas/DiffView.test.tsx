import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCardUI } from '@renderer/store/useChatStore'
import type { ToolProposal } from '@shared/types'

/**
 * The canvas diff is a *review* surface, so what matters is which write it puts in
 * front of you and what it says became of it. A write still awaiting a decision has
 * to win over a newer applied one — being blocked on you is the more urgent fact —
 * and a rejected write must still be readable afterwards, because "what did I turn
 * down" is the question you come back here to answer.
 *
 * Monaco is replaced by a `<pre>` pair: the real editor needs a layout engine jsdom
 * doesn't have, and what the component actually decides is *which bytes* go in, which
 * a fake renders just as well.
 */
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="diff">
      <pre data-testid="original">{original}</pre>
      <pre data-testid="modified">{modified}</pre>
    </div>
  )
}))

const { DiffView } = await import('@renderer/components/canvas/DiffView')
const { useChatStore } = await import('@renderer/store/useChatStore')

/**
 * A write card whose new bytes name their own file, so the diff pane itself says
 * which card is on screen — the header and the picker list both show the base name,
 * so a query on the name alone can't tell them apart.
 */
function write(id: string, path: string, over: Partial<ToolCardUI> = {}): ToolCardUI {
  const proposal: ToolProposal = {
    id,
    kind: 'write_file',
    path,
    oldContent: 'a\nb\n',
    newContent: `a\nB\n// ${path}\n`,
    exists: true
  }
  return {
    id,
    runId: 'run-1',
    afterMessageId: 'm-1',
    proposal,
    auto: false,
    status: 'complete',
    startedAt: 1_700_000_000_000,
    ...over
  }
}

/** A read card, which the diff must ignore entirely. */
const READ: ToolCardUI = {
  id: 'r-1',
  runId: 'run-1',
  afterMessageId: 'm-1',
  proposal: { id: 'r-1', kind: 'read', op: 'read_file', path: 'src/other.ts' },
  auto: true,
  status: 'complete'
}

function seed(tools: ToolCardUI[]): void {
  act(() => {
    useChatStore.setState({ tools })
  })
}

/** The path of the write actually rendered, read out of the modified pane. */
function shown(): string {
  return screen.getByTestId('modified').textContent?.split('// ')[1] ?? ''
}

beforeEach(() => {
  seed([])
})

describe('DiffView', () => {
  it('says no file has changed rather than showing an empty editor', () => {
    seed([READ])
    render(<DiffView />)
    expect(screen.getByText('No file changes yet.')).toBeTruthy()
    expect(screen.queryByTestId('diff')).toBeNull()
  })

  it('shows the newest write, with its folder and line counts', () => {
    seed([write('w-1', 'src/old.ts'), write('w-2', 'src/renderer/App.tsx')])
    render(<DiffView />)

    expect(shown()).toBe('src/renderer/App.tsx\n')
    // Name big, folder small — the folder is context, not the headline.
    expect(screen.getByText('src/renderer')).toBeTruthy()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
    expect(screen.getByTestId('original').textContent).toBe('a\nb\n')
  })

  it('puts an awaiting write ahead of a newer applied one', () => {
    seed([write('w-1', 'src/awaiting.ts', { status: 'awaiting' }), write('w-2', 'src/applied.ts')])
    render(<DiffView />)
    // Being blocked on you outranks recency: that is the diff the run is stuck on.
    expect(shown()).toBe('src/awaiting.ts\n')
    expect(screen.getByText('awaiting your go-ahead')).toBeTruthy()
  })

  it('names what became of the write in one word', () => {
    const cases: Array<[Partial<ToolCardUI>, string]> = [
      [{ status: 'complete' }, 'applied'],
      [{ status: 'awaiting' }, 'awaiting your go-ahead'],
      [{ decision: 'reject' }, 'rejected'],
      [{ status: 'running' }, 'running'],
      [
        { result: { id: 'w-1', kind: 'write_file', ok: false, error: 'EACCES' } },
        'failed'
      ]
    ]
    for (const [over, word] of cases) {
      seed([write('w-1', 'src/a.ts', over)])
      const { unmount } = render(<DiffView />)
      expect(screen.getByText(word)).toBeTruthy()
      unmount()
    }
  })

  it('keeps a rejected write readable, since that is what you come back to check', () => {
    seed([write('w-1', 'src/a.ts', { decision: 'reject', status: 'complete' })])
    render(<DiffView />)
    expect(shown()).toBe('src/a.ts\n')
    expect(screen.getByText('rejected')).toBeTruthy()
  })

  it('lists the run’s earlier writes only once there is more than one', () => {
    seed([write('w-1', 'src/only.ts')])
    const { unmount } = render(<DiffView />)
    expect(screen.queryByRole('button')).toBeNull()
    unmount()

    seed([write('w-1', 'src/first.ts'), write('w-2', 'src/second.ts')])
    render(<DiffView />)
    // Newest first in the list, so the current write is the row at the top.
    const rows = screen.getAllByRole('button')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('title')).toBe('src/second.ts')
    expect(rows[1].getAttribute('title')).toBe('src/first.ts')
  })

  it('pins an earlier write when picked, and unpins on a second click', () => {
    seed([write('w-1', 'src/first.ts'), write('w-2', 'src/second.ts')])
    render(<DiffView />)
    expect(shown()).toBe('src/second.ts\n')

    fireEvent.click(screen.getAllByRole('button')[1])
    expect(shown()).toBe('src/first.ts\n')

    // Clicking the shown one lets go, back to whatever is current.
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(shown()).toBe('src/second.ts\n')
  })

  it('drops a pin whose card left the thread instead of showing nothing', () => {
    seed([write('w-1', 'src/first.ts'), write('w-2', 'src/second.ts')])
    render(<DiffView />)
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(shown()).toBe('src/first.ts\n')

    // A new chat clears the cards; the pinned id no longer exists.
    seed([write('w-3', 'src/third.ts')])
    expect(shown()).toBe('src/third.ts\n')
  })

  it('shows --:--:-- for a write whose start was never recorded', () => {
    seed([write('w-1', 'src/first.ts', { startedAt: undefined }), write('w-2', 'src/second.ts')])
    render(<DiffView />)
    // A pre-v9 persisted op has no stamp, and printing the epoch would be a lie.
    expect(screen.getByText('--:--:--')).toBeTruthy()
  })
})
