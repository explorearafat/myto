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

// The Myto mark (monochrome mitochondria — a tilted organic bean with a double membrane and four
// rounded finger-like cristae) as an inline SVG, matching the renderer's MytoMark.tsx / public/myto-mark.svg
// geometry so the browser handoff page shows the real logo, not a text glyph. Inked for the light handoff page.
function markSvg(size: number): string {
  const paths = [
    '<path stroke-width="17" d="M100 260C100 212 134 178 182 170C214 165 234 187 258 193C284 199 302 170 342 168C394 166 436 202 434 254C432 306 398 348 344 356C302 362 282 368 252 368C194 368 132 354 110 320C97 300 98 282 100 260Z"/>',
    '<path stroke-width="13" d="M142 258C142 224 168 204 202 199C228 195 244 209 266 214C288 219 302 200 330 200C366 200 394 222 392 256C390 292 366 320 328 326C300 330 284 334 258 334C214 334 174 324 156 302C143 288 142 274 142 258Z"/>',
    '<path stroke-width="14" d="M184 300C172 274 176 244 192 224"/>',
    '<path stroke-width="15" d="M216 312C206 282 210 242 226 216"/>',
    '<path stroke-width="14" d="M250 312C244 284 254 248 272 226"/>',
    '<path stroke-width="13" d="M286 302C282 282 292 262 310 248"/>'
  ].join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" ` +
    `fill="none" stroke="#181818" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Myto">` +
    `<g transform="rotate(12 256 256)">${paths}</g></svg>`
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
    markSvg(44) +
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
        res.end(page('Sign-in failed', 'Something went wrong. Return to Myto and try again.'))
        finish({ ok: false, error: 'The sign-in response was invalid. Please try again.' })
        return
      }
      res.end(page("You're signed in", 'You can close this tab and return to Myto.'))
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
