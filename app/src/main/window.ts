import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { IpcChannel } from '../shared/ipc'

let cspInstalled = false
function installContentSecurityPolicy(isDev: boolean): void {
  if (cspInstalled) return
  cspInstalled = true

  // `img-src` also allows https://*.googleusercontent.com so the signed-in user's
  // Google profile photo (shown in the conversation rail footer) can load; every
  // other remote origin stays blocked. The renderer still falls back to an initials
  // avatar if the image is unavailable.
  const policy = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https://*.googleusercontent.com; " +
      "worker-src 'self' blob:; connect-src 'self' ws: http://localhost:* https://*.googleapis.com"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self' data:; img-src 'self' data: https://*.googleusercontent.com; worker-src 'self' blob:; " +
      "connect-src 'self' https://*.googleapis.com"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}

export function createWindow(): BrowserWindow {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  installContentSecurityPolicy(isDev)
  const brandIcon = app.isPackaged ? undefined : join(app.getAppPath(), 'resources', 'icon.png')

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0D1117',
    ...(brandIcon ? { icon: brandIcon } : {}),
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Enables the <webview> used by the right-side live preview. The guest runs
      // in its own `partition="preview"` session (so the strict app CSP doesn't
      // clamp it) and is only ever pointed at localhost URLs.
      webviewTag: true
    }
  })

  window.on('ready-to-show', () => window.show())
  const emitMaximizedState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannel.WindowMaximizedChanged, window.isMaximized())
    }
  }
  window.on('maximize', emitMaximizedState)
  window.on('unmaximize', emitMaximizedState)
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
