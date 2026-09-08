import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The rail's restyle moved things between regions, and *where* a control lives is
 * the whole point of it: the mode switch and New chat were pulled out of the scroll
 * region because scrolling away is not acceptable for the control that decides
 * whether Sylor may touch your files, and the six settings deep-links were folded
 * into one hairline pad because they were costing the chat list ~180px of column.
 *
 * So these tests pin behaviour that a re-layout can silently break: every pad key
 * still opens the pane it names, the switch still writes `workMode`, the Browser row
 * still toggles the panel and says which way it is pointing, and the footer's Ctrl K
 * still reaches the palette. They assert on real store state rather than on spies —
 * nothing here is mocked beyond the `window.sylor` bridge the setup file already
 * stubs.
 */
const { ConversationRail } = await import('@renderer/components/ConversationRail')
const { useAppStore } = await import('@renderer/store/useAppStore')

beforeEach(() => {
  useAppStore.setState({
    settingsOpen: false,
    settingsTab: null,
    browserOpen: false,
    paletteOpen: false,
    workMode: 'cowork'
  })
})

describe('the Configure pad', () => {
  it('opens the pane each key names', () => {
    render(<ConversationRail />)
    const cases: Array<[string, string]> = [
      ['Connectors', 'connectors'],
      ['Skills', 'skills'],
      ['Commands', 'commands'],
      ['Plugins', 'plugins'],
      ['Model', 'model'],
      ['Browsing', 'browsing']
    ]
    for (const [label, tab] of cases) {
      act(() => {
        fireEvent.click(screen.getByText(label))
      })
      expect(useAppStore.getState().settingsOpen).toBe(true)
      expect(useAppStore.getState().settingsTab).toBe(tab)
    }
  })

  it('titles every key, because the label truncates at the rail’s minimum width', () => {
    render(<ConversationRail />)
    for (const label of ['Connectors', 'Skills', 'Commands', 'Plugins', 'Model', 'Browsing']) {
      expect(screen.getByText(label).closest('button')).toHaveAttribute('title')
    }
  })
})

describe('the mode switch', () => {
  it('writes the mode and marks which one is live', () => {
    render(<ConversationRail />)
    const cowork = screen.getByText('Cowork').closest('button')!
    const code = screen.getByText('Code').closest('button')!
    expect(cowork).toHaveAttribute('aria-pressed', 'true')
    expect(code).toHaveAttribute('aria-pressed', 'false')

    act(() => {
      fireEvent.click(code)
    })
    expect(useAppStore.getState().workMode).toBe('code')
    expect(screen.getByText('Code').closest('button')).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps both modes reachable without scrolling — they sit outside the scroll region', () => {
    const { container } = render(<ConversationRail />)
    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    expect(scroller!.contains(screen.getByText('Cowork'))).toBe(false)
    expect(scroller!.contains(screen.getByText('New chat'))).toBe(false)
  })
})

describe('the Browser row', () => {
  it('toggles the panel and says so while it is open', () => {
    render(<ConversationRail />)
    expect(screen.queryByText('On')).toBeNull()

    act(() => {
      fireEvent.click(screen.getByText('Browser'))
    })
    expect(useAppStore.getState().browserOpen).toBe(true)
    expect(screen.getByText('On')).toBeTruthy()

    act(() => {
      fireEvent.click(screen.getByText('Browser'))
    })
    expect(useAppStore.getState().browserOpen).toBe(false)
    expect(screen.queryByText('On')).toBeNull()
  })
})

describe('the footer', () => {
  it('opens settings with no tab preselected', () => {
    render(<ConversationRail />)
    act(() => {
      fireEvent.click(screen.getByText('Settings'))
    })
    expect(useAppStore.getState().settingsOpen).toBe(true)
    expect(useAppStore.getState().settingsTab).toBeNull()
  })

  it('reaches the palette by click, for anyone who never learns the shortcut', () => {
    render(<ConversationRail />)
    act(() => {
      fireEvent.click(screen.getByLabelText('Open the command palette'))
    })
    expect(useAppStore.getState().paletteOpen).toBe(true)
  })
})
