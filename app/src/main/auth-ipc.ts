import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ipcMain, shell } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { AuthHandoffResult } from '../shared/types'

/*
 * Browser-mediated Google sign-in for the desktop app.
 *
 * Google refuses its OAuth screen inside an embedded webview (disallowed_useragent),
 * so the app never shows it in-process. Instead we open the user's real browser to the
 * website's /authentication page and receive the resulting Google ID token back on a
 * short-lived loopback HTTP listener (127.0.0.1, ephemeral port — the RFC 8252 pattern
 * for native apps). The renderer then completes Firebase sign-in with that token via
 * signInWithCredential. No server secret and no token minting happens here.
 *
 * A random `state` nonce ties the browser round-trip to this request, and binding to
 * 127.0.0.1 keeps the listener local (and avoids a Windows Firewall prompt).
 */

const AUTH_PAGE = 'https://sylorcode.vercel.app/authentication'
const TIMEOUT_MS = 3 * 60_000

// The Sylor star (twelve-ray terracotta sunburst) as an inline SVG — matches the renderer's
// SylorStar.tsx geometry so the browser handoff page shows the real mark, not a text glyph.
const LONG_RAY = 'M12 1.4C12.85 6 12.85 8.4 12 11C11.15 8.4 11.15 6 12 1.4Z'
const SHORT_RAY = 'M12 4.8C12.6 7.4 12.6 8.9 12 11C11.4 8.9 11.4 7.4 12 4.8Z'

function starSvg(size: number): string {
  const rays = Array.from(
    { length: 12 },
    (_, i) =>
      `<path d="${i % 2 === 0 ? LONG_RAY : SHORT_RAY}" transform="rotate(${i * 30} 12 12)"/>`
  ).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="#cf5535" role="img" aria-label="Sylor">${rays}</svg>`
  )
}

function page(title: string, body: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    title +
    '</title><style>html{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#faf9f5;' +
    'color:#141413}body{display:grid;place-items:center;min-height:100vh;margin:0}' +
    '.c{max-width:22rem;text-align:center;padding:2rem}.s{display:inline-grid;place-items:center;' +
    'margin-bottom:1rem}h1{font-size:1.25rem;margin:.25rem 0}' +
    'p{color:rgba(20,20,19,.6);font-size:.9rem}</style></head><body><div class="c">' +
    '<div class="s">' +
    starSvg(44) +
    '</div><h1>' +
    title +
    '</h1><p>' +
    body +
    '</p></div></body></html>'
  )
}

function runGoogleSignIn(): Promise<AuthHandoffResult> {
  return new Promise((resolve) => {
    const state = randomBytes(16).toString('hex')
    let settled = false

    const finish = (result: AuthHandoffResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Let the HTTP response flush before tearing the listener down.
      setTimeout(() => server.close(), 150)
      resolve(result)
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      const idToken = url.searchParams.get('id_token') || ''
      const gotState = url.searchParams.get('state') || ''
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (!idToken || gotState !== state) {
        res.end(page('Sign-in failed', 'Something went wrong. Return to Sylor and try again.'))
        finish({ ok: false, error: 'The sign-in response was invalid. Please try again.' })
        return
      }
      res.end(page("You're signed in", 'You can close this tab and return to Sylor.'))
      finish({ ok: true, idToken })
    })

    const timer = setTimeout(
      () => finish({ ok: false, error: 'Sign-in timed out. Please try again.' }),
      TIMEOUT_MS
    )

    server.on('error', () =>
      finish({ ok: false, error: 'Could not start the local sign-in listener.' })
    )

    // Ephemeral loopback port; the browser is told which one via the URL below.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      if (!port) {
        finish({ ok: false, error: 'Could not start the local sign-in listener.' })
        return
      }
      const target = `${AUTH_PAGE}?platform=desktop&port=${port}&state=${state}`
      void shell.openExternal(target)
    })
  })
}

export function registerAuthIpc(): void {
  ipcMain.handle(IpcChannel.AuthSignInWithGoogle, (): Promise<AuthHandoffResult> => runGoogleSignIn())
}
