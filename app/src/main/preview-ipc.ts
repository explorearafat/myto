import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { PreviewEvent, PreviewInspectRequest, PreviewInspectResponse } from '../shared/types'
import { setPreviewInspectTransport, type PreviewInspectPayload } from './preview/inspect'
import { setPreviewEmitter, startAuto, startDev, startStatic, stopPreview } from './preview/server'

/** How long to wait for the renderer to answer a `preview_inspect` request. */
const INSPECT_TIMEOUT_MS = 15_000

/** In-flight `preview_inspect` requests, keyed by `requestId` (see below). */
interface PendingInspect {
  resolve: (response: PreviewInspectResponse) => void
  timer: NodeJS.Timeout
}

/**
 * Registers the live-preview IPC. `start-static`/`start-dev` are invoke/handle
 * (the renderer awaits the resolved URL), while lifecycle events — `ready` from
 * a boot, `reload` from the file watcher, `error` from a failed dev server —
 * arrive asynchronously, so the server pushes them through a persistent sink.
 *
 * That sink broadcasts to every open window (Sylor is single-window in practice)
 * because a watcher `reload` isn't tied to any one renderer request.
 *
 * The `preview_inspect` transport is the inverse flow: the engine (main) asks the
 * renderer (which owns the `<webview>`) to run a browser-verification action. We
 * post a {@link PreviewInspectRequest} tagged with a fresh `requestId`, park a
 * promise in {@link pending}, and resolve it when the renderer sends back the
 * matching {@link PreviewInspectResponse}. A timeout guarantees the engine never
 * hangs if no window is listening or the guest wedged.
 */
export function registerPreviewIpc(): void {
  setPreviewEmitter((payload: PreviewEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcChannel.PreviewEvent, payload)
    }
  })

  ipcMain.handle(IpcChannel.PreviewStartStatic, (_event: IpcMainInvokeEvent, entry?: string) =>
    startStatic(entry)
  )
  ipcMain.handle(IpcChannel.PreviewStartDev, (_event: IpcMainInvokeEvent, command: string) =>
    startDev(command)
  )
  ipcMain.handle(IpcChannel.PreviewStartAuto, (_event: IpcMainInvokeEvent, entry?: string) =>
    startAuto(entry)
  )
  ipcMain.on(IpcChannel.PreviewStop, () => {
    stopPreview()
  })

  // ── preview_inspect round-trip (engine → renderer → engine) ──
  const pending = new Map<string, PendingInspect>()

  // The renderer's reply: match it to its parked promise and resolve. A late or
  // duplicate reply (already timed out) simply finds nothing and is ignored.
  ipcMain.on(
    IpcChannel.PreviewInspectResult,
    (_event, response: PreviewInspectResponse) => {
      const entry = pending.get(response.requestId)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(response.requestId)
      entry.resolve(response)
    }
  )

  // Inject the transport the engine calls. Resolving (never rejecting) with a
  // failure response keeps the agent loop's error handling uniform — a closed
  // preview reads as a normal failed tool-result, not an exception.
  setPreviewInspectTransport((payload: PreviewInspectPayload) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) {
      return Promise.resolve({
        requestId: '',
        ok: false,
        output: 'No app window is open to drive the preview.',
        truncated: false,
        summary: 'no window',
        error: 'no window'
      })
    }
    const requestId = randomUUID()
    const request: PreviewInspectRequest = { ...payload, requestId }
    return new Promise<PreviewInspectResponse>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({
          requestId,
          ok: false,
          output: `The preview did not respond within ${INSPECT_TIMEOUT_MS / 1000}s.`,
          truncated: false,
          summary: 'timed out',
          error: 'preview inspect timed out'
        })
      }, INSPECT_TIMEOUT_MS)
      pending.set(requestId, { resolve, timer })
      win.webContents.send(IpcChannel.PreviewInspectRequest, request)
    })
  })
}
