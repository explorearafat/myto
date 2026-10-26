import { describe, it, expect } from 'vitest'
import { QUICK_ACTIONS } from './actions'

describe('QUICK_ACTIONS', () => {
  it('covers the core flows with unique ids', () => {
    const ids = QUICK_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('explain')
    expect(ids).toContain('review')
    expect(ids).toContain('write-tests')
    expect(ids).toContain('fix-tests')
    expect(ids).toContain('init-memory')
  })
  it('builds tasks that name the workspace and are self-sufficient', () => {
    for (const a of QUICK_ACTIONS) {
      const task = a.task('C:\\some\\project')
      expect(task).toContain('C:\\some\\project')
      expect(task.length).toBeGreaterThan(40)
    }
  })
  it('the review action keeps the agent read-only', () => {
    const review = QUICK_ACTIONS.find((a) => a.id === 'review')!
    expect(review.task('ws')).toContain('Do not edit any files')
  })
})
