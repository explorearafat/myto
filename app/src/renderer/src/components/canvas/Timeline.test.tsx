import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Timeline } from '@renderer/components/canvas/Timeline'
import { useChatStore } from '@renderer/store/useChatStore'
import { useAppStore } from '@renderer/store/useAppStore'
import type { CheckpointInfo, RestoreResult } from '@shared/types'

/**
 * The rollback surface, so what these tests pin is honesty and consent rather than
 * layout: a restore reports what it actually put back (an empty list reads as a
 * no-op, not as a success), it names the undo point only when one was really
 * taken, the way back is two clicks, and it is refused outright while a run is
 * still writing into the tree.
 */
const listMock = window.sylor.checkpoints.list as unknown as ReturnType<typeof vi.fn>
const restoreMock = window.sylor.checkpoints.restore as unknown as ReturnType<typeof vi.fn>

const point = (over: Partial<CheckpointInfo> & { id: string }): CheckpointInfo => ({
  at: 1_700_000_000_000,
  label: 'Before writing src/App.tsx',
  kind: 'git',
  sha: 'abc1234',
  ...over
})

/**
 * Put `points` in the store AND behind the IPC read, because a restore re-reads the
 * list: if the mock still answered `[]` the rows would vanish mid-assertion and the
 * panel would fall back to its empty state.
 */
function seed(points: CheckpointInfo[], opts: { running?: boolean } = {}): void {
  listMock.mockResolvedValue(points)
  useChatStore.setState({ checkpoints: points, running: opts.running ?? false })
}

/** The verdict the main process will hand back for the next restore. */
function verdict(result: RestoreResult): void {
  restoreMock.mockResolvedValue(result)
}

beforeEach(() => {
  listMock.mockClear()
  restoreMock.mockClear()
  // Null root = the boot instant, which the mount effect deliberately sits out.
  // Tests that care about the read set one themselves.
  useAppStore.setState({ workspaceRoot: null })
  seed([])
})

/** Arms and fires the two-step restore on the only row on screen. */
async function restoreTheOnlyRow(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Restore to here' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(restoreMock).toHaveBeenCalled())
}

describe('Timeline', () => {
  it('explains that points appear on their own rather than showing an empty frame', () => {
    render(<Timeline />)
    expect(screen.getByText('No restore points yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restore to here' })).toBeNull()
  })

  it('waits for the folder to be known before reading the timeline', async () => {
    render(<Timeline />)
    expect(listMock).not.toHaveBeenCalled()

    // A read at the boot instant would answer for whatever root main defaulted to,
    // so the effect is keyed on the workspace instead of on mount alone.
    useAppStore.setState({ workspaceRoot: '/test' })
    await waitFor(() => expect(listMock).toHaveBeenCalled())
  })

  it('says how many points this folder has and what each one was taken before', () => {
    seed([point({ id: 'cp-2', label: 'Before running npm test' }), point({ id: 'cp-1' })])
    render(<Timeline />)

    expect(screen.getByText('2 restore points for this folder')).toBeTruthy()
    expect(screen.getByText('Before running npm test')).toBeTruthy()
    expect(screen.getByText('Before writing src/App.tsx')).toBeTruthy()
  })

  it('says a files point holds only what Sylor wrote', () => {
    seed([point({ id: 'cp-1', kind: 'files', sha: undefined, files: ['src/App.tsx'] })])
    render(<Timeline />)

    expect(screen.getByText('files').getAttribute('title')).toBe(
      'Copies of the files Sylor wrote — a restore brings back only those'
    )
  })

  it('needs a second click before it rewrites anything', () => {
    seed([point({ id: 'cp-1' })])
    render(<Timeline />)

    fireEvent.click(screen.getByRole('button', { name: 'Restore to here' }))
    // Armed, not fired: nothing has been asked of the main process yet.
    expect(restoreMock).not.toHaveBeenCalled()
    expect(screen.getByText(/Puts the files back as they were at this point/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel this restore' }))
    expect(restoreMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('reports an empty restore as nothing to put back, not as a rollback', async () => {
    seed([point({ id: 'cp-1' })])
    verdict({ ok: true, restored: [] })
    render(<Timeline />)
    await restoreTheOnlyRow()

    expect(restoreMock).toHaveBeenCalledWith('cp-1')
    await waitFor(() =>
      expect(
        screen.getByText('Nothing to put back — the files already match this point.')
      ).toBeTruthy()
    )
  })

  it('counts the files it really rewrote and names the undo point it took first', async () => {
    seed([point({ id: 'cp-1' })])
    verdict({
      ok: true,
      restored: ['src/App.tsx', 'src/main.tsx'],
      safety: { id: 'cp-safety', at: 1_700_000_100_000, label: 'Before restore', kind: 'git', auto: true }
    })
    render(<Timeline />)
    await restoreTheOnlyRow()

    await waitFor(() =>
      expect(
        screen.getByText('Put back 2 files. An undo point was saved first.')
      ).toBeTruthy()
    )
    // The safety point is a real new row on disk, so the list is re-read rather
    // than patched — otherwise the way back from the rollback would be invisible.
    expect(listMock).toHaveBeenCalled()
  })

  it('claims no undo point when the engine did not manage to take one', async () => {
    seed([point({ id: 'cp-1' })])
    verdict({ ok: true, restored: ['src/App.tsx'] })
    render(<Timeline />)
    await restoreTheOnlyRow()

    await waitFor(() => expect(screen.getByText('Put back 1 file.')).toBeTruthy())
    expect(screen.queryByText(/An undo point was saved first/)).toBeNull()
  })

  it('passes a refusal through in the words the main process used', async () => {
    seed([point({ id: 'cp-1' })])
    verdict({ ok: false, error: 'That checkpoint is no longer on record.' })
    render(<Timeline />)
    await restoreTheOnlyRow()

    await waitFor(() =>
      expect(screen.getByText('That checkpoint is no longer on record.')).toBeTruthy()
    )
  })

  it('refuses to restore while the agent is still writing, and says why', () => {
    seed([point({ id: 'cp-2' }), point({ id: 'cp-1' })], { running: true })
    render(<Timeline />)

    const buttons = screen.getAllByRole('button', { name: 'Restore to here' })
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toBeDisabled()
      expect(button.getAttribute('title')).toBe(
        'Stop the run first — restoring while Sylor is still writing would fight its own edits'
      )
    }
    // The header carries the same reason, so a greyed-out row is never a mystery.
    expect(
      screen.getByText('2 restore points for this folder · restoring is paused while a run is live')
    ).toBeTruthy()
  })

  it('marks the point a restore took for itself so it is not mistaken for a step', () => {
    seed([point({ id: 'cp-safety', label: 'Before restore', auto: true })])
    render(<Timeline />)

    expect(screen.getByText('undo').getAttribute('title')).toBe(
      'Taken automatically so a restore could itself be undone'
    )
  })
})
