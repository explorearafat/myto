import { describe, expect, it } from 'vitest'
import {
  emptyBoardMessage,
  filterCounts,
  FILTER_ORDER,
  matchesFilter,
  matchesQuery,
  needsAttention,
  type CatalogItem
} from '@renderer/lib/catalogFilter'

/**
 * The filter strip's rules. The one worth pinning is that `attention` cuts across
 * on/off: a connector the user switched on can still be dead (no key on disk, a
 * failed transport), and that is exactly the row the strip exists to surface — so
 * an enabled-but-unconfigured server has to land in BOTH `on` and `attention`.
 */
const server = (over: Partial<CatalogItem> = {}): CatalogItem => ({ enabled: true, state: 'connected', ...over })
const skill = (enabled: boolean): CatalogItem => ({ enabled })

describe('needsAttention', () => {
  it('flags a server that failed to connect', () => {
    expect(needsAttention(server({ state: 'error' }))).toBe(true)
  })

  it('flags a server that is missing its config, even though it is switched on', () => {
    expect(needsAttention(server({ enabled: true, state: 'unconfigured' }))).toBe(true)
  })

  it('leaves connected, connecting and off servers alone', () => {
    expect(needsAttention(server({ state: 'connected' }))).toBe(false)
    expect(needsAttention(server({ state: 'connecting' }))).toBe(false)
    expect(needsAttention(server({ enabled: false, state: 'disabled' }))).toBe(false)
  })

  it('never flags a skill, which has no connection to fail', () => {
    expect(needsAttention(skill(true))).toBe(false)
    expect(needsAttention(skill(false))).toBe(false)
  })
})

describe('matchesFilter', () => {
  it('passes everything under All', () => {
    expect(matchesFilter(server({ enabled: false }), 'all')).toBe(true)
    expect(matchesFilter(server({ enabled: true }), 'all')).toBe(true)
  })

  it('splits On and Off by the switch alone', () => {
    expect(matchesFilter(skill(true), 'on')).toBe(true)
    expect(matchesFilter(skill(true), 'off')).toBe(false)
    expect(matchesFilter(skill(false), 'off')).toBe(true)
    expect(matchesFilter(skill(false), 'on')).toBe(false)
  })

  it('keeps a broken-but-enabled server in On as well as Needs setup', () => {
    const broken = server({ enabled: true, state: 'error' })
    expect(matchesFilter(broken, 'on')).toBe(true)
    expect(matchesFilter(broken, 'attention')).toBe(true)
  })
})

describe('filterCounts', () => {
  it('counts each bucket, with off as the complement of on', () => {
    const items = [
      server({ enabled: true, state: 'connected' }),
      server({ enabled: true, state: 'unconfigured' }),
      server({ enabled: false, state: 'disabled' }),
      server({ enabled: false, state: 'error' })
    ]
    expect(filterCounts(items)).toEqual({ all: 4, on: 2, off: 2, attention: 2 })
  })

  it('reports an empty attention bucket for skills, so the strip can hide it', () => {
    expect(filterCounts([skill(true), skill(false), skill(false)])).toEqual({
      all: 3,
      on: 1,
      off: 2,
      attention: 0
    })
  })

  it('handles an empty board', () => {
    expect(filterCounts([])).toEqual({ all: 0, on: 0, off: 0, attention: 0 })
  })
})

describe('matchesQuery', () => {
  it('matches everything while the box is blank or whitespace', () => {
    expect(matchesQuery(['filesystem'], '')).toBe(true)
    expect(matchesQuery(['filesystem'], '   ')).toBe(true)
  })

  it('matches any field, case-insensitively, on a substring', () => {
    expect(matchesQuery(['github', 'GitHub', 'Issues and pull requests'], 'PULL')).toBe(true)
    expect(matchesQuery(['github', 'GitHub', 'Issues and pull requests'], 'sqlite')).toBe(false)
  })

  it('skips fields that are absent rather than throwing on them', () => {
    expect(matchesQuery(['git', undefined], 'git')).toBe(true)
    expect(matchesQuery([undefined], 'git')).toBe(false)
  })
})

describe('emptyBoardMessage', () => {
  it('names the query, and the bucket it came up empty in', () => {
    expect(emptyBoardMessage('all', 'sqlite', 'connectors')).toBe('Nothing matches “sqlite”.')
    expect(emptyBoardMessage('on', ' sqlite ', 'connectors')).toBe(
      'Nothing matches “sqlite” under On.'
    )
  })

  it('reads an empty attention bucket as good news, not as a dead end', () => {
    expect(emptyBoardMessage('attention', '', 'connectors')).toBe(
      'Nothing needs setup — everything switched on is working.'
    )
  })

  it('writes a sentence for every bucket — no interpolated pill label', () => {
    for (const filter of FILTER_ORDER) {
      const message = emptyBoardMessage(filter, '', 'skills')
      expect(message).toMatch(/\.$/)
      // "Nothing is needs setup right now" is what a single template produces; the
      // pill labels must not appear in prose at all when there is no query.
      expect(message).not.toMatch(/is (All|On|Off|Needs setup)/i)
    }
  })

  it('says which noun the board holds', () => {
    expect(emptyBoardMessage('all', '', 'skills')).toBe('No skills yet.')
    expect(emptyBoardMessage('on', '', 'connectors')).toBe('No connectors are switched on yet.')
  })
})
