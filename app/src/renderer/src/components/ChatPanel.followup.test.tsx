import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FollowupBar } from '@renderer/components/ChatPanel'
import { buildFollowupPrompt } from '@shared/followups'
import type { Followup } from '@shared/types'

/**
 * #5 — the flagged-follow-up chips. `flag_followup` records out-of-scope work the
 * agent noticed and deliberately did NOT do; this bar is how the user acts on it.
 * These pin the two honesty rules the UI carries: it never claims a file that wasn't
 * written, and dismissing is only a hide (the written entry is untouched, which the
 * store enforces — here we only prove the id is reported for dismissal).
 */
const recorded: Followup = {
  id: 'fu-1',
  title: 'Fix the stale README badge',
  note: 'It points at the old CI workflow name, so it always renders as unknown.',
  files: ['README.md'],
  recordedIn: '.sylor/FOLLOWUPS.md'
}

describe('FollowupBar', () => {
  it('renders nothing when there are no follow-ups', () => {
    const { container } = render(
      <FollowupBar followups={[]} disabled={false} onStart={() => {}} onDismiss={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the title, note, files, and where it was written', () => {
    render(
      <FollowupBar followups={[recorded]} disabled={false} onStart={() => {}} onDismiss={() => {}} />
    )
    expect(screen.getByText('Fix the stale README badge')).toBeTruthy()
    expect(screen.getByText(/always renders as unknown/)).toBeTruthy()
    expect(screen.getByText(/README\.md · noted in \.sylor\/FOLLOWUPS\.md/)).toBeTruthy()
    expect(screen.getByText('1 follow-up')).toBeTruthy()
  })

  it('says the finding is session-only when nothing could be written', () => {
    render(
      <FollowupBar
        followups={[{ id: 'fu-2', title: 'Drop the dead flag' }]}
        disabled={false}
        onStart={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByText(/this session only — nothing could be written/)).toBeTruthy()
    expect(screen.queryByText(/noted in/)).toBeNull()
  })

  it('counts more than one', () => {
    render(
      <FollowupBar
        followups={[recorded, { id: 'fu-2', title: 'Drop the dead flag' }]}
        disabled={false}
        onStart={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByText('2 follow-ups')).toBeTruthy()
  })

  it('starts the follow-up it was clicked on', () => {
    const onStart = vi.fn()
    render(
      <FollowupBar
        followups={[recorded, { id: 'fu-2', title: 'Drop the dead flag' }]}
        disabled={false}
        onStart={onStart}
        onDismiss={() => {}}
      />
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Do it now' })[1])
    expect(onStart).toHaveBeenCalledWith({ id: 'fu-2', title: 'Drop the dead flag' })
  })

  it('cannot be started while a turn is running', () => {
    const onStart = vi.fn()
    render(
      <FollowupBar followups={[recorded]} disabled onStart={onStart} onDismiss={() => {}} />
    )
    const start = screen.getByRole('button', { name: 'Do it now' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.click(start)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('reports the id when dismissed', () => {
    const onDismiss = vi.fn()
    render(
      <FollowupBar followups={[recorded]} disabled={false} onStart={() => {}} onDismiss={onDismiss} />
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss follow-up: Fix the stale README badge' })
    )
    expect(onDismiss).toHaveBeenCalledWith('fu-1')
  })
})

describe('buildFollowupPrompt', () => {
  it('folds the note and the files into the new turn', () => {
    expect(buildFollowupPrompt(recorded)).toBe(
      'Fix the stale README badge\n' +
        'It points at the old CI workflow name, so it always renders as unknown.\n' +
        'Files: README.md'
    )
  })

  it('is just the title when there is nothing else', () => {
    expect(buildFollowupPrompt({ id: 'fu-2', title: 'Drop the dead flag' })).toBe(
      'Drop the dead flag'
    )
  })
})
