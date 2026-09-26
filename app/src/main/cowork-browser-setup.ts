/**
 * "Setup Myto Browser" — a standalone, human-driven browser window.
 *
 * The agent's in-app browser (see cowork-browser-runtime.ts) drives a BrowserWindow on the
 * `persist:myto-inapp-browser` partition. THIS window opens on the SAME partition but with
 * no debugger attached: the user navigates it by hand to log into Gmail / WhatsApp / Facebook
 * / Telegram / etc. Because the profile is shared and persistent, those cookies survive, so
 * when Myto later browses on the user's behalf it is already signed in — no credentials ever
 * pass through the model. GUI/OS-facing, so (like the runtime) it has no unit tests.
 */

import { BrowserWindow, session } from 'electron'
import { chromeUserAgent } from './cowork-browser'

/** Must match the in-app agent browser's partition so logins are shared (cowork-browser-runtime.ts). */
const SETUP_PARTITION = 'persist:myto-inapp-browser'

/**
 * A vanilla Chrome User-Agent for this window. Electron's default UA carries `Electron/…`
 * and `Myto/…` tokens that WhatsApp Web / some Google login pages sniff and reject with
 * "update Google Chrome" — so a manual login here would dead-end on that screen. Presenting
 * plain Chrome lets the user actually sign in. Set at the SESSION level (below) so every
 * OAuth popup on the shared partition inherits it too. See {@link chromeUserAgent}.
 */
const SETUP_UA = chromeUserAgent(process.platform)

/** One window at a time — a second "Setup" click focuses the existing one. */
let setupWindow: BrowserWindow | null = null

/** The quick-login shortcuts shown on the portal start page. */
const SHORTCUTS: Array<{ label: string; url: string }> = [
  { label: 'Gmail', url: 'https://mail.google.com' },
  { label: 'WhatsApp', url: 'https://web.whatsapp.com' },
  { label: 'Facebook', url: 'https://www.facebook.com' },
  { label: 'Messenger', url: 'https://www.messenger.com' },
  { label: 'Instagram', url: 'https://www.instagram.com' },
  { label: 'Telegram', url: 'https://web.telegram.org' },
  { label: 'X', url: 'https://x.com' },
  { label: 'YouTube', url: 'https://www.youtube.com' },
  { label: 'LinkedIn', url: 'https://www.linkedin.com' },
  { label: 'Outlook', url: 'https://outlook.live.com' }
]

/** The portal start page: a Google search box + one-tap login tiles. Plain HTML, navigates the top frame. */
function portalPage(): string {
  const tiles = SHORTCUTS.map(
    (s) => `<a class="tile" href="${s.url}">${s.label}</a>`
  ).join('')
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>Setup Myto Browser</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'html,body{height:100%;margin:0}' +
    "body{font:15px/1.6 system-ui,Segoe UI,sans-serif;color:#181818;background:#faf9f7;" +
    'display:flex;align-items:center;justify-content:center}' +
    '.wrap{max-width:44rem;padding:2.5rem;text-align:center}' +
    'h1{font-size:1.5rem;margin:0 0 .35rem}p{color:#555;margin:0 0 1.6rem}' +
    'form{display:flex;gap:.5rem;margin:0 auto 1.8rem;max-width:34rem}' +
    'input{flex:1;padding:.7rem .9rem;border:1px solid #d8d4cd;border-radius:.6rem;font-size:15px;outline:none}' +
    'input:focus{border-color:#b0a8a0}' +
    'button{padding:.7rem 1.1rem;border:0;border-radius:.6rem;background:#181818;color:#fff;font-size:14px;cursor:pointer}' +
    '.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.6rem}' +
    '.tile{display:block;padding:.85rem;border:1px solid #e2ded7;border-radius:.7rem;background:#fff;' +
    'color:#181818;text-decoration:none;font-weight:500;transition:border-color .15s,background .15s}' +
    '.tile:hover{border-color:#b0a8a0;background:#f4f2ee}' +
    '.hint{margin-top:1.8rem;font-size:12.5px;color:#8a847c}' +
    '</style></head><body><div class="wrap">' +
    '<h1>Setup Myto Browser</h1>' +
    '<p>Log in to your accounts here once. Myto reuses these sessions when it browses for you — ' +
    'your passwords never pass through the model.</p>' +
    '<form action="https://www.google.com/search" method="GET">' +
    '<input name="q" placeholder="Search Google or type a website" autofocus>' +
    '<button type="submit">Search</button></form>' +
    `<div class="tiles">${tiles}</div>` +
    '<div class="hint">Alt+← / Alt+→ to go back/forward · Ctrl+R to reload · Alt+Home for this page</div>' +
    '</div></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** Wire keyboard navigation onto a window's WebContents (no chrome/address bar on this window). */
function wireNavigation(win: BrowserWindow): void {
  const wc = win.webContents
  wc.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const nav = wc.navigationHistory
    if (input.alt && key === 'arrowleft') {
      if (nav.canGoBack()) nav.goBack()
    } else if (input.alt && key === 'arrowright') {
      if (nav.canGoForward()) nav.goForward()
    } else if ((input.control && key === 'r') || key === 'f5') {
      wc.reload()
    } else if (input.alt && key === 'home') {
      void wc.loadURL(portalPage())
    }
  })
}

/**
 * Open (or focus) the Setup Myto Browser window. Resolves once it is shown. Reuses the shared
 * persistent partition so the logins the user makes here are the ones Myto's browser tools see.
 */
export function openBrowserSetup(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    if (setupWindow.isMinimized()) setupWindow.restore()
    setupWindow.focus()
    return
  }
  // Present as plain Chrome on the WHOLE shared partition BEFORE the window loads, so this
  // window AND any OAuth popup it spawns are seen as a supported browser (not "update Chrome").
  try {
    session.fromPartition(SETUP_PARTITION).setUserAgent(SETUP_UA)
  } catch {
    // best-effort — never let the UA override stop the window from opening.
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: true,
    title: 'Setup Myto Browser',
    autoHideMenuBar: true,
    webPreferences: { partition: SETUP_PARTITION, sandbox: true, contextIsolation: true }
  })
  setupWindow = win
  // Also pin the UA on this WebContents (covers navigator.userAgent for the pages it loads).
  win.webContents.setUserAgent(SETUP_UA)
  win.on('closed', () => {
    if (setupWindow === win) setupWindow = null
  })
  // OAuth "Login with Google/Facebook" flows open popups — allow them on the same profile so
  // the sign-in completes and its cookies land in the shared partition.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      webPreferences: { partition: SETUP_PARTITION, sandbox: true, contextIsolation: true }
    }
  }))
  // Make sure each popup also reports plain Chrome (belt-and-braces alongside the session UA).
  win.webContents.on('did-create-window', (child) => {
    try {
      child.webContents.setUserAgent(SETUP_UA)
    } catch {
      // ignore — popup may already be gone.
    }
  })
  wireNavigation(win)
  void win.loadURL(portalPage())
  win.focus()
}
