import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { PreviewPanel } from '@renderer/components/PreviewPanel'
import { useAppStore } from '@renderer/store/useAppStore'
import type { WebviewElement } from '@renderer/types/webview'

/**
 * Regression guard for the "The workspace hit an error" crash.
 *
 * A live-preview reload that fires while the `<webview>` guest is not yet
 * `dom-ready` used to call `reload()` straight away; Electron throws
 * "The WebView must be attached to the DOM and the dom-ready event emitted before
 * this method can be called." synchronously, and because the call sits inside a
 * React effect the throw reaches the commit phase and trips the workspace
 * ErrorBoundary — blanking the panel. It hit hardest during big tasks, where rapid
 * file writes bump the reload nonce while server restarts keep remounting the guest.
 *
 * jsdom has no real `<webview>`, so the rendered element is a plain
 * HTMLUnknownElement; we attach the imperative `reload()` the panel calls and drive
 * `dom-ready` by hand.
 */

const PREVIEW_URL = 'http://127.0.0.1:5173/'

/** The live `<webview>` the panel just mounted, with a stubbed `reload()`. */
function stubReload(container: HTMLElement, reload: Mock): WebviewElement {
  const el = container.querySelector('webview') as unknown as WebviewElement
  ;(el as unknown as { reload: Mock }).reload = reload
  return el
}

/** Bump the file-change reload nonce, the way a main-process `reload` event does. */
function bumpReloadNonce(): void {
  act(() => {
    useAppStore.setState((s) => ({ previewReloadNonce: s.previewReloadNonce + 1 }))
  })
}

beforeEach(() => {
  // A loaded, non-error preview so the panel renders the <webview> on first paint.
  // Reset happens here (before render, nothing mounted) rather than in an afterEach,
  // which would race React Testing Library's unmount and update a live component
  // outside act(). Vitest isolates modules per file, so no state leaks across files.
  useAppStore.setState({
    previewUrl: PREVIEW_URL,
    previewPhase: 'ready',
    previewError: null,
    previewReloadNonce: 0
  })
})

describe('PreviewPanel live-reload gate', () => {
  it('defers a file-change reload until the guest emits dom-ready', () => {
    const reload = vi.fn()
    const { container } = render(<PreviewPanel />)
    const el = stubReload(container, reload)

    // Before dom-ready the reload must be held, never called on the detached guest.
    bumpReloadNonce()
    expect(reload).not.toHaveBeenCalled()

    // dom-ready flushes the one pending reload.
    act(() => {
      el.dispatchEvent(new Event('dom-ready'))
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('swallows a reload that throws mid-flight without crashing the panel', () => {
    const reload = vi.fn(() => {
      throw new Error(
        'The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.'
      )
    })
    const { container } = render(<PreviewPanel />)
    const el = stubReload(container, reload)

    // Guest becomes ready, then a file change fires a reload that throws (the guest
    // was torn down between the ready check and the call). If the throw escaped the
    // effect, act() would rethrow it and fail this test.
    act(() => {
      el.dispatchEvent(new Event('dom-ready'))
    })
    bumpReloadNonce()

    expect(reload).toHaveBeenCalledTimes(1)
    // Panel is still mounted (no ErrorBoundary swap): its webview is still present.
    expect(container.querySelector('webview')).not.toBeNull()
  })

  it('reloads immediately once the guest is ready', () => {
    const reload = vi.fn()
    const { container } = render(<PreviewPanel />)
    const el = stubReload(container, reload)

    act(() => {
      el.dispatchEvent(new Event('dom-ready'))
    })
    // A change after the guest is live reloads right away — no deferral.
    bumpReloadNonce()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
