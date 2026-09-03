import type { PreviewInspectRequest, PreviewInspectResponse } from '../../shared/types'

/**
 * The main-side seam for driving the live browser preview.
 *
 * The preview is a RENDERER-owned `<webview>` (see PreviewPanel.tsx), so the
 * engine (main process) cannot touch it directly. It hands one action to this
 * module; the injected {@link PreviewInspectTransport} performs the actual
 * main→renderer→main IPC round-trip (wired in `preview-ipc.ts`) and resolves
 * with the renderer's reply.
 *
 * This indirection mirrors {@link setPreviewEmitter} in `server.ts`: keeping the
 * electron/IPC machinery behind an injected function lets the engine (and its
 * tests) import `requestPreviewInspect` without pulling in `electron`, and lets a
 * test substitute a fake transport to exercise the whole `preview_inspect` path
 * headlessly.
 */

/** What the wired transport receives: an action payload minus its correlation id. */
export type PreviewInspectPayload = Omit<PreviewInspectRequest, 'requestId'>

/** Performs the real round-trip to the renderer and back. */
export type PreviewInspectTransport = (
  payload: PreviewInspectPayload
) => Promise<PreviewInspectResponse>

let transport: PreviewInspectTransport | null = null

/**
 * Wire the renderer round-trip (set once by preview-ipc on registration; cleared
 * to `null` when no window is available). Injected so this module stays
 * electron-free and unit-testable.
 */
export function setPreviewInspectTransport(fn: PreviewInspectTransport | null): void {
  transport = fn
}

/**
 * Run one `preview_inspect` action against the live preview and resolve with the
 * renderer's reply. When no transport is wired (no window, or the preview pane is
 * closed) this resolves with an actionable failure rather than throwing, so the
 * agent loop reads a clear "start the preview first" note and can recover.
 */
export async function requestPreviewInspect(
  payload: PreviewInspectPayload
): Promise<PreviewInspectResponse> {
  if (!transport) {
    return {
      requestId: '',
      ok: false,
      output:
        'No live preview is running. Start the preview (open the app in the preview pane) and then re-run the check.',
      truncated: false,
      summary: 'no preview',
      error: 'preview not running'
    }
  }
  return transport(payload)
}
