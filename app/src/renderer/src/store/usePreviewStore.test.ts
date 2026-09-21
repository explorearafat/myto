import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreviewStore, currentTarget } from './usePreviewStore'
import type { PreviewTarget } from '@shared/types'

const fileA: PreviewTarget = { kind: 'file', url: 'file:///w/a.html', title: 'a.html' }
const fileB: PreviewTarget = { kind: 'file', url: 'file:///w/b.html', title: 'b.html' }
const urlC: PreviewTarget = { kind: 'url', url: 'http://localhost:5173/', title: 'http://localhost:5173' }

beforeEach(() => {
  usePreviewStore.setState({ open: false, history: [], index: -1, reloadNonce: 0 })
})

describe('usePreviewStore', () => {
  it('opens and shows a target', () => {
    usePreviewStore.getState().show(fileA)
    const s = usePreviewStore.getState()
    expect(s.open).toBe(true)
    expect(currentTarget(s)).toEqual(fileA)
    expect(s.history).toEqual([fileA])
    expect(s.index).toBe(0)
  })

  it('pushes new targets and tracks the cursor like a browser', () => {
    const { show } = usePreviewStore.getState()
    show(fileA)
    show(fileB)
    show(urlC)
    const s = usePreviewStore.getState()
    expect(s.history).toEqual([fileA, fileB, urlC])
    expect(s.index).toBe(2)
    expect(currentTarget(s)).toEqual(urlC)
  })

  it('re-showing the same url is a reload, not a new entry', () => {
    const { show } = usePreviewStore.getState()
    show(fileA)
    const before = usePreviewStore.getState().reloadNonce
    show({ ...fileA }) // same url
    const s = usePreviewStore.getState()
    expect(s.history).toEqual([fileA])
    expect(s.index).toBe(0)
    expect(s.reloadNonce).toBe(before + 1)
  })

  it('steps back and forward within bounds', () => {
    const { show, back, forward } = usePreviewStore.getState()
    show(fileA)
    show(fileB)
    back()
    expect(usePreviewStore.getState().index).toBe(0)
    back() // clamp at start
    expect(usePreviewStore.getState().index).toBe(0)
    forward()
    expect(usePreviewStore.getState().index).toBe(1)
    forward() // clamp at end
    expect(usePreviewStore.getState().index).toBe(1)
  })

  it('showing after going back truncates the forward entries', () => {
    const { show, back } = usePreviewStore.getState()
    show(fileA)
    show(fileB)
    back() // now at fileA, fileB is "forward"
    show(urlC)
    const s = usePreviewStore.getState()
    expect(s.history).toEqual([fileA, urlC])
    expect(s.index).toBe(1)
    expect(currentTarget(s)).toEqual(urlC)
  })

  it('reload bumps the nonce', () => {
    const { show, reload } = usePreviewStore.getState()
    show(fileA)
    const before = usePreviewStore.getState().reloadNonce
    reload()
    expect(usePreviewStore.getState().reloadNonce).toBe(before + 1)
  })

  it('close hides the pane but keeps history', () => {
    const { show, close } = usePreviewStore.getState()
    show(fileA)
    close()
    const s = usePreviewStore.getState()
    expect(s.open).toBe(false)
    expect(s.history).toEqual([fileA])
    expect(currentTarget(s)).toEqual(fileA)
  })

  it('openExternal sends the current url to the shell', () => {
    const spy = vi.fn()
    ;(window as unknown as { sylor: { preview: { openExternal: typeof spy } } }).sylor.preview.openExternal =
      spy
    const { show, openExternal } = usePreviewStore.getState()
    show(urlC)
    openExternal()
    expect(spy).toHaveBeenCalledWith(urlC.url)
  })

  it('currentTarget is null when nothing has been shown', () => {
    expect(currentTarget(usePreviewStore.getState())).toBeNull()
  })
})
