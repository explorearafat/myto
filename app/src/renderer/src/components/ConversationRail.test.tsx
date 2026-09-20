import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The rail is a plain-chatbot sidebar now: the Sylor wordmark, a New-chat action,
 * the nav cluster (Projects / Artifacts / Code / Customize), the date-bucketed
 * recents list, and a footer showing the signed-in Google account — avatar, first
 * name and plan — beside an icon cluster (search · collapse). These tests pin the
 * behaviour a re-layout can silently break: the collapse control folds the rail,
 * the footer shows the account, and the account button opens Settings with no tab
 * preselected. They assert real store state, not spies.
 *
 * `useAuthUser` is mocked so the footer has a deterministic account and Firebase
 * never initialises under jsdom.
 */
vi.mock('@renderer/lib/useAuthUser', () => ({
  useAuthUser: () => ({
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    photoURL: null
  })
}))

const { ConversationRail } = await import('@renderer/components/ConversationRail')
const { useAppStore } = await import('@renderer/store/useAppStore')
const { useSessionStore } = await import('@renderer/store/useSessionStore')

beforeEach(() => {
  useAppStore.setState({ settingsOpen: false, settingsTab: null, railOpen: true })
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    activeProjectId: null,
    navStack: [],
    navPos: -1
  })
})

describe('the toolbar', () => {
  it('collapses the rail', () => {
    render(<ConversationRail />)
    act(() => {
      fireEvent.click(screen.getByLabelText('Collapse sidebar'))
    })
    expect(useAppStore.getState().railOpen).toBe(false)
  })
})

describe('the footer', () => {
  it('shows the signed-in account by first name and plan', () => {
    render(<ConversationRail />)
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByText('· Free')).toBeTruthy()
  })

  it('opens settings with no tab preselected', () => {
    render(<ConversationRail />)
    act(() => {
      // Clicking the account name bubbles to the footer's account button.
      fireEvent.click(screen.getByText('Ada'))
    })
    expect(useAppStore.getState().settingsOpen).toBe(true)
    expect(useAppStore.getState().settingsTab).toBeNull()
  })
})
