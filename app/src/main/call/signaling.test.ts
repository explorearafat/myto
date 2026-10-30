import { describe, expect, it } from 'vitest'

import { buildLiveCallsQuery, signalDocId } from './signaling'

describe('signalDocId', () => {
  it('zero-pads the sequence so lexicographic order equals numeric order', () => {
    const ids = [0, 2, 10, 99, 100].map((n) => signalDocId('desktop', n))
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids) // already in numeric order
    expect(signalDocId('desktop', 10)).toBe('sig-d-0010')
    expect(signalDocId('mobile', 0)).toBe('sig-m-0000')
  })
})

describe('buildLiveCallsQuery', () => {
  it('filters to live states with a bounded limit', () => {
    const q = buildLiveCallsQuery() as {
      from: Array<{ collectionId: string }>
      where: { fieldFilter: { field: { fieldPath: string }; op: string; value: { arrayValue: { values: Array<{ stringValue: string }> } } } }
      limit: number
    }
    expect(q.from[0].collectionId).toBe('calls')
    expect(q.where.fieldFilter.field.fieldPath).toBe('state')
    expect(q.where.fieldFilter.op).toBe('IN')
    const states = q.where.fieldFilter.value.arrayValue.values.map((v) => v.stringValue)
    expect(states).toEqual(['ringing', 'incoming', 'accepted'])
    expect(q.limit).toBeLessThanOrEqual(20)
  })
})
