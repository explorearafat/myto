import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TodoPanel } from '@renderer/components/ChatPanel'
import type { TodoItem } from '@shared/types'

/**
 * #4 — the live task checklist. The model owns the list through `update_todos` and
 * re-sends the whole thing each time, so the panel is a pure projection: it shows
 * exactly the items given, in order, and a done/total tally. These pin that it
 * renders every item's text and reflects each status, without inventing state of
 * its own. (The gate that shows it only while a turn is streaming lives in
 * AssistantMessage; here we test the panel in isolation.)
 */
const list: TodoItem[] = [
  { text: 'Add the /logout route', status: 'completed' },
  { text: 'Wire the header button', status: 'in_progress' },
  { text: 'Add a logout test', status: 'pending' }
]

describe('TodoPanel', () => {
  it('renders every step in order with a done/total tally', () => {
    render(<TodoPanel todos={list} />)
    expect(screen.getByText('Add the /logout route')).toBeTruthy()
    expect(screen.getByText('Wire the header button')).toBeTruthy()
    expect(screen.getByText('Add a logout test')).toBeTruthy()
    // One of three items is completed.
    expect(screen.getByText('1/3')).toBeTruthy()
  })

  it('strikes through a completed step but not the others', () => {
    render(<TodoPanel todos={list} />)
    expect(screen.getByText('Add the /logout route').className).toContain('line-through')
    expect(screen.getByText('Wire the header button').className).not.toContain('line-through')
    expect(screen.getByText('Add a logout test').className).not.toContain('line-through')
  })

  it('marks each status with its own glyph', () => {
    render(<TodoPanel todos={list} />)
    // completed → a check, in_progress → a spinner dot, pending → an empty ring.
    expect(screen.getByLabelText('done')).toBeTruthy()
    expect(screen.getByLabelText('in progress')).toBeTruthy()
    expect(screen.getByLabelText('to do')).toBeTruthy()
  })
})
