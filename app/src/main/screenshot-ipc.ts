import { desktopCapturer, ipcMain, screen } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { ScreenshotResult } from '../shared/types'

/*
 * Screenshot capture (#11).
 *
 * Grabs the primary display at full resolution via Electron's `desktopCapturer`
 * and returns the PNG bytes so the renderer can stage them as an ordinary image
 * attachment (same path as paste / drag-drop). This is always user-initiated —
 * fired from an explicit button in the composer — and reads the whole screen, so
 * it is deliberately not automatic. Resolves `null` on any failure, including the
 * OS withholding screen-recording permission (macOS), so the UI can fall back to
 * "paste a screenshot" without surfacing a scary error.
 */
async function capturePrimaryScreen(): Promise<ScreenshotResult | null> {
  try {
    // Capture at the display's real pixel size (accounting for HiDPI) so the shot
    // is crisp rather than a small thumbnail.
    const primary = screen.getPrimaryDisplay()
    const { width, height } = primary.size
    const scale = primary.scaleFactor || 1
    const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) }

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    if (sources.length === 0) return null

    // Prefer the source matching the primary display; fall back to the first screen.
    const primaryId = String(primary.id)
    const source =
      sources.find((s) => s.display_id === primaryId) ?? sources[0]
    const image = source.thumbnail
    if (image.isEmpty()) return null

    const data = image.toPNG().toString('base64')
    if (!data) return null

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    return { data, mime: 'image/png', name: `screenshot-${stamp}.png` }
  } catch (error) {
    console.error('[myto] screenshot capture failed:', error)
    return null
  }
}

export function registerScreenshotIpc(): void {
  ipcMain.handle(IpcChannel.ScreenshotCapture, () => capturePrimaryScreen())
}
