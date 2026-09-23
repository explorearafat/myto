import { ipcMain, shell } from 'electron'
import { IpcChannel } from '../shared/ipc'

/*
 * Myto's preview pane — external-open handler.
 *
 * The preview pane is a renderer-side <webview>; the only thing it can't do
 * in-process is hand a URL to the operating system. This handler does exactly
 * that (the pane's "open in my browser" control), for the two URL shapes a
 * PreviewTarget ever carries: a `file://` working-folder artifact or an http(s)
 * page. Anything else is refused — this must not become a way to launch
 * arbitrary shell targets.
 */
function openExternal(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('[myto] preview openExternal refused non-file/http url:', parsed.protocol)
      return
    }
    void shell.openExternal(url)
  } catch (error) {
    console.error('[myto] preview openExternal failed:', error)
  }
}

export function registerPreviewIpc(): void {
  ipcMain.on(IpcChannel.PreviewOpenExternal, (_event, url: string) => openExternal(url))
}
