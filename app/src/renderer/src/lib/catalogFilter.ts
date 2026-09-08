/**
 * catalogFilter — the state filter behind the Connectors and Skills boards.
 *
 * Both panes list a couple of dozen items of which only a handful are ever on, so
 * "which of these are actually live?" is the question they get asked most — and the
 * one they could not answer: the only signal was a 20px switch at the right edge of
 * each row, one row at a time. These helpers back a filter strip that answers it in
 * one click, and they live here rather than in `SettingsPanel.tsx` because that file
 * exports only components, and a second kind of export there costs a react-refresh
 * lint warning.
 *
 * `attention` is deliberately orthogonal to on/off: a connector can be switched on
 * and still be unusable — no API key on disk, a transport that failed — and that is
 * the state most worth pulling out of a long list. Skills have no connection state
 * at all, so their bucket is always empty and the strip drops it rather than showing
 * a zero the user can click into nothing.
 */
import type { McpConnectionState } from '@shared/types'

/** The buckets the board's filter strip offers. */
export type CatalogFilter = 'all' | 'on' | 'off' | 'attention'

/** The slice of a connector/skill this module needs in order to judge its state. */
export interface CatalogItem {
  enabled: boolean
  /** Connection state — connectors only. A skill is just on or off. */
  state?: McpConnectionState
}

/** True when the item cannot work until the user does something (bad config, failed connect). */
export function needsAttention(item: CatalogItem): boolean {
  return item.state === 'error' || item.state === 'unconfigured'
}

/** Whether an item belongs in the given bucket. */
export function matchesFilter(item: CatalogItem, filter: CatalogFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'on':
      return item.enabled
    case 'off':
      return !item.enabled
    case 'attention':
      return needsAttention(item)
  }
}

/** How many items each bucket holds — the counts printed on the strip. */
export function filterCounts(items: readonly CatalogItem[]): Record<CatalogFilter, number> {
  let on = 0
  let attention = 0
  for (const item of items) {
    if (item.enabled) on += 1
    if (needsAttention(item)) attention += 1
  }
  return { all: items.length, on, off: items.length - on, attention }
}

/**
 * Case-insensitive substring search across an item's text fields. A blank query
 * matches everything, so the caller can hand the raw input box value straight in
 * without branching on it.
 */
export function matchesQuery(fields: ReadonlyArray<string | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return fields.some((field) => field !== undefined && field.toLowerCase().includes(q))
}

/** The strip's pill labels. */
export const FILTER_LABEL: Record<CatalogFilter, string> = {
  all: 'All',
  on: 'On',
  off: 'Off',
  attention: 'Needs setup'
}

/** The order the pills appear in. */
export const FILTER_ORDER: readonly CatalogFilter[] = ['all', 'on', 'off', 'attention']

/**
 * What a board says when the current filter and query leave it with nothing.
 *
 * Phrased per bucket rather than from one template: `Nothing is ${label} right now`
 * yields "Nothing is needs setup right now", and an empty `attention` bucket is the
 * one empty result that is good news — it means everything switched on is working,
 * which is worth saying instead of leaving the user staring at a dead end.
 */
export function emptyBoardMessage(filter: CatalogFilter, query: string, noun: string): string {
  const q = query.trim()
  if (q !== '') {
    return `Nothing matches “${q}”${filter === 'all' ? '' : ` under ${FILTER_LABEL[filter]}`}.`
  }
  switch (filter) {
    case 'attention':
      return 'Nothing needs setup — everything switched on is working.'
    case 'on':
      return `No ${noun} are switched on yet.`
    case 'off':
      return `Every one of your ${noun} is switched on.`
    case 'all':
      return `No ${noun} yet.`
  }
}
