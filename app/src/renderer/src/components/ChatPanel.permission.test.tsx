import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCardUI } from '@renderer/store/useChatStore'
import type { ToolProposal } from '@shared/types'

/**
 * Phase 2 — "no silent writes". The permission bar is where a write is reviewable
 * BEFORE it exists on disk, so these tests are about the three things that makes
 * true: the bytes are visible, they are editable, and a refusal can carry a reason.
 *
 * The Monaco diff is replaced by a seam that is honest about the one thing this
 * component depends on — `getModifiedEditor()` plus a content-change callback — so
 * "typing in the modified pane" is a real assertion rather than a mocked-away one.
 */
const fake = vi.hoisted(() => ({ value: '', fire: () => {} }))

interface FakeMount {
  getModifiedEditor: () => {
    updateOptions: (options: object) => void
    onDidChangeModelContent: (cb: () => void) => void
    getValue: () => string
  }
}

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    modified,
    onMount
  }: {
    modified: string
    onMount: (editor: FakeMount) => void
  }) => {
    fake.value = modified
    onMount({
      getModifiedEditor: () => ({
        updateOptions: () => {},
        onDidChangeModelContent: (cb: () => void) => {
          fake.fire = cb
        },
        getValue: () => fake.value
      })
    })
    return <pre data-testid="diff">{modified}</pre>
  }
}))

const { PermissionBar, StandingBar } = await import('@renderer/components/ChatPanel')

/** The user types `text` into the modified pane of the open diff. */
const type = (text: string): void =>
  act(() => {
    fake.value = text
    fake.fire()
  })

function card(id: string, proposal: ToolProposal): ToolCardUI {
  return { id, runId: 'r1', afterMessageId: 'm1', proposal, auto: false, status: 'awaiting' }
}

const WRITE = card('t-w', {
  id: 't-w',
  kind: 'write_file',
  path: 'src/app.ts',
  oldContent: 'const a = 1\nconst b = 2\n',
  newContent: 'const a = 1\nconst b = 3\nconst c = 4\n',
  exists: true
})
const CMD = card('t-c', { id: 't-c', kind: 'run_command', command: 'npm test' })
const FETCH = card('t-f', { id: 't-f', kind: 'web_fetch', url: 'https://example.com' })

describe('PermissionBar (diff-first editing)', () => {
  it('heads a write with its line counts, collapsed until asked', () => {
    render(<PermissionBar awaiting={[WRITE]} onDecide={() => {}} />)
    expect(screen.getByText('Approval needed')).toBeTruthy()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
    // The diff is a click away, not in your face — a bar that unfolds every pending
    // file at once is unreadable the moment there are three of them.
    expect(screen.queryByTestId('diff')).toBeNull()
  })

  it('shows the proposed bytes, and says they are not on disk yet', () => {
    render(<PermissionBar awaiting={[WRITE]} onDecide={() => {}} />)
    fireEvent.click(screen.getByTitle('Review the diff before it is written'))
    expect(screen.getByTestId('diff').textContent).toBe('const a = 1\nconst b = 3\nconst c = 4\n')
    expect(
      screen.getByText('Nothing is on disk yet — edit here and Approve writes your version.')
    ).toBeTruthy()
  })

  it('approves the untouched proposal with no edit claim attached', () => {
    const onDecide = vi.fn()
    render(<PermissionBar awaiting={[WRITE]} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    // `undefined`, not `{ editedContent: <the proposal> }`: "the user edited this"
    // has to mean they did.
    expect(onDecide).toHaveBeenCalledWith('t-w', 'approve', undefined)
  })

  it('sends the body the user typed, and shows that it will', () => {
    const onDecide = vi.fn()
    render(<PermissionBar awaiting={[WRITE]} onDecide={onDecide} />)
    fireEvent.click(screen.getByTitle('Review the diff before it is written'))
    type('const a = 1\nconst b = 3 // mine\n')

    // The row says so before you commit to it…
    expect(screen.getByText('your edit')).toBeTruthy()
    // …and the counts track what is actually about to be written, not the proposal.
    expect(screen.getByText('+1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith('t-w', 'approve', {
      editedContent: 'const a = 1\nconst b = 3 // mine\n'
    })
  })

  it('lets the user take their edit back', () => {
    const onDecide = vi.fn()
    render(<PermissionBar awaiting={[WRITE]} onDecide={onDecide} />)
    fireEvent.click(screen.getByTitle('Review the diff before it is written'))
    type('something else\n')
    fireEvent.click(screen.getByRole('button', { name: 'Revert my edits' }))

    expect(screen.queryByText('your edit')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith('t-w', 'approve', undefined)
  })

  it('asks why before it sends a rejection, then carries the reason', () => {
    const onDecide = vi.fn()
    render(<PermissionBar awaiting={[WRITE]} onDecide={onDecide} />)

    // First click opens the field rather than firing: "no" without "because" makes
    // the model guess at the correction.
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onDecide).not.toHaveBeenCalled()
    const why = screen.getByPlaceholderText('Why not? (optional — it goes to the model)')
    fireEvent.change(why, { target: { value: 'wrong folder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onDecide).toHaveBeenCalledWith('t-w', 'reject', { reason: 'wrong folder' })
  })

  it('sends the reason on Enter, and abandons the field on Escape', () => {
    const onDecide = vi.fn()
    render(<PermissionBar awaiting={[WRITE]} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const why = screen.getByPlaceholderText('Why not? (optional — it goes to the model)')
    fireEvent.change(why, { target: { value: 'not yet' } })
    fireEvent.keyDown(why, { key: 'Enter' })
    expect(onDecide).toHaveBeenCalledWith('t-w', 'reject', { reason: 'not yet' })

    fireEvent.keyDown(why, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Why not? (optional — it goes to the model)')).toBeNull()
  })

  it('offers "Always" only where a standing grant is actually possible', () => {
    const { unmount } = render(<PermissionBar awaiting={[WRITE]} onDecide={() => {}} />)
    expect(
      screen.getByRole('button', { name: 'Always' }).getAttribute('title')
    ).toBe('Approve this and stop asking about file edits for the rest of this run')
    unmount()

    // A command grant names the exact command — that narrowness is what makes it
    // safe to give.
    const cmd = render(<PermissionBar awaiting={[CMD]} onDecide={() => {}} />)
    expect(screen.getByRole('button', { name: 'Always' }).getAttribute('title')).toContain(
      '`npm test`'
    )
    cmd.unmount()

    // Leaving the machine has no per-run shortcut, so no button promises one.
    render(<PermissionBar awaiting={[FETCH]} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Always' })).toBeNull()
  })

  it('escalates with the same edit the row is showing', () => {
    const onDecide = vi.fn()
    render(<PermissionBar awaiting={[WRITE]} onDecide={onDecide} />)
    fireEvent.click(screen.getByTitle('Review the diff before it is written'))
    type('mine\n')
    fireEvent.click(screen.getByRole('button', { name: 'Always' }))
    expect(onDecide).toHaveBeenCalledWith('t-w', 'approve-always', { editedContent: 'mine\n' })
  })

  it('answers a batch one op at a time, with no borrowed detail', () => {
    const onDecide = vi.fn()
    render(<PermissionBar awaiting={[WRITE, CMD]} onDecide={onDecide} />)
    expect(screen.getByText('2 actions need approval')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    expect(onDecide.mock.calls).toEqual([
      ['t-w', 'approve'],
      ['t-c', 'approve']
    ])

    onDecide.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }))
    expect(onDecide.mock.calls).toEqual([
      ['t-w', 'reject'],
      ['t-c', 'reject']
    ])
  })

  it('renders nothing when nothing is waiting', () => {
    const { container } = render(<PermissionBar awaiting={[]} onDecide={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('StandingBar (grants in force)', () => {
  it('names each grant in the user’s terms and withdraws it in one click', () => {
    const onRevoke = vi.fn()
    render(
      <StandingBar keys={['write_file', 'run_command:npm test']} onRevoke={onRevoke} />
    )
    expect(screen.getByText('Not asking about:')).toBeTruthy()
    expect(screen.getByText('File edits')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Ask me again about File edits' }))
    expect(onRevoke).toHaveBeenCalledWith('write_file')
  })

  it('shows an unrecognised key verbatim rather than inventing a name for it', () => {
    render(<StandingBar keys={['some_future_kind:x']} onRevoke={() => {}} />)
    expect(screen.getByText('some_future_kind:x')).toBeTruthy()
  })

  it('takes no space when no grant is in force', () => {
    const { container } = render(<StandingBar keys={[]} onRevoke={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
