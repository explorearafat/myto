import { describe, it, expect } from 'vitest'
import { faceRows, faceLines, effortLabel, type DashRow } from './face'
import { stripAnsi } from './ui'

const dash = (): { rows: DashRow[]; selected: number } => ({
  rows: [
    { label: 'Working Folder', value: '~/projects/new-app' },
    { label: 'Model', value: 'claude-3.5-sonnet' },
    { label: 'Effort', value: 'Advanced' },
    { label: 'API Status', value: 'Connected · gateway' }
  ],
  selected: 2
})

describe('faceRows', () => {
  it('draws dots, (*) eyes, ## cheeks and MYTO across the middle', () => {
    const joined = faceRows(dash()).join('\n')
    expect(joined).toContain('·') // dotted crown
    expect(joined).toContain('(*)') // eyes
    expect(joined).toContain('##') // cheeks
    expect(joined).toContain('M  Y  T  O') // the wordmark mid-face
    expect(joined).toContain('\\_') // the smile
  })
  it('has uniform visible width per row', () => {
    const widths = new Set(faceRows(dash()).map((r) => r.length))
    expect(widths.size).toBe(1)
  })
  it('renders the dashboard rows in a box under the face', () => {
    const rows = faceRows(dash())
    const joined = rows.join('\n')
    expect(joined).toContain('Working Folder')
    expect(joined).toContain('~/projects/new-app')
    expect(joined).toContain('claude-3.5-sonnet')
    expect(joined).toContain('Advanced')
    expect(joined).toContain('Connected · gateway')
  })
  it('marks only the selected dashboard row', () => {
    const rows = faceRows(dash())
    const marked = rows.filter((r) => r.includes('▸'))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('Effort')
    // No selection → no marker anywhere.
    expect(faceRows({ ...dash(), selected: -1 }).join('\n')).not.toContain('▸')
  })
  it('truncates long values to keep the box clean', () => {
    const rows = faceRows({
      rows: [{ label: 'Model', value: 'x'.repeat(80) }],
      selected: -1
    })
    const modelRow = rows.find((r) => r.includes('xxx'))!
    expect(modelRow).toContain('…')
    expect(modelRow.length).toBeLessThan(60)
  })
})

describe('faceLines', () => {
  it('keeps the visible text identical to the plain rows', () => {
    const colored = faceLines(dash()).map(stripAnsi)
    expect(colored).toEqual(faceRows(dash()))
  })
})

describe('effortLabel', () => {
  it('maps the dial to human names', () => {
    expect(effortLabel('low')).toBe('Low')
    expect(effortLabel('medium')).toBe('Balanced')
    expect(effortLabel('high')).toBe('Advanced')
    expect(effortLabel(undefined)).toBe('Balanced')
  })
})
