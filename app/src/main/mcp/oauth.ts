/**
 * OAuth 2.1 for remote MCP servers.
 *
 * Some hosted MCP servers authenticate with OAuth rather than a static header.
 * The SDK does the protocol work (discovery, dynamic client registration, PKCE,
 * token refresh) provided we hand it an {@link OAuthClientProvider} that knows
 * how to persist credentials and how to put a consent screen in front of the
 * user. This module is that provider, plus the loopback listener that catches the
 * authorization code the browser is redirected back to.
 *
 * Design constraints that shaped it:
 *  - **Opt-in only.** Nothing here runs unless a server's config says
 *    `"oauth": true`, so Sylor never pops a browser window unbidden.
 *  - **Electron-free.** The browser opener is injected ({@link OAuthDeps}), so
 *    this file is plain Node and unit-testable without an Electron runtime.
 *  - **Loopback, not a public redirect.** The redirect URI is
 *    `http://127.0.0.1:<ephemeral>/callback`, bound before the consent screen
 *    opens and closed the moment the flow settles. The `state` parameter is
 *    generated and checked, so another page on the machine can't feed us a code.
 *  - **The PKCE verifier stays in memory.** It's only meaningful for the single
 *    in-flight exchange; persisting it would be a durable secret for no gain.
 *    Tokens and the registered client *are* persisted (`~/.sylor/mcp-auth.json`,
 *    written 0600) so the user consents once, not once per launch.
 *  - **Never logged.** Tokens and client secrets are returned to the SDK and
 *    written to disk; they never reach a log line or the model's context.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { sylorHome } from './config'

/** How long we wait for the user to finish the consent screen before giving up. */
const AUTH_TIMEOUT_MS = 5 * 60_000

/** Absolute path of the credential store (`~/.sylor/mcp-auth.json`). */
export function mcpAuthPath(): string {
  return join(sylorHome(), 'mcp-auth.json')
}

/** What one server's slot in the store holds. */
interface StoredAuth {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** The loopback port the last successful sign-in registered; reused when free. */
  port?: number
}

/** The whole file: server name → credentials. */
interface AuthFile {
  servers?: Record<string, StoredAuth>
}

/** Reads the store; a missing or corrupt file yields an empty one (never throws). */
function readStore(path: string): AuthFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as AuthFile) : {}
  } catch {
    return {}
  }
}

/** Merges one server's slot into the store on disk, 0600, creating `~/.sylor` if needed. */
function writeSlot(path: string, server: string, patch: StoredAuth): void {
  const file = readStore(path)
  const servers = file.servers ?? {}
  servers[server] = { ...servers[server], ...patch }
  file.servers = servers
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

/** Drops fields from one server's slot (or the whole slot when `keys` is empty). */
function clearSlot(path: string, server: string, keys: (keyof StoredAuth)[]): void {
  const file = readStore(path)
  if (!file.servers?.[server]) return
  if (keys.length === 0) delete file.servers[server]
  else for (const k of keys) delete file.servers[server][k]
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

/** Injected side effects, so the flow is testable without Electron or a real browser. */
export interface OAuthDeps {
  /** Shows the consent screen — in production, `shell.openExternal`. */
  openExternal: (url: string) => void | Promise<void>
  /** Credential store location. Defaults to {@link mcpAuthPath}. */
  storePath?: string
  /** Consent timeout override (tests use a short one). */
  timeoutMs?: number
}

/**
 * A live authorization attempt: the provider to hand the SDK transport, plus the
 * loopback listener that is *already bound* (the port is baked into the provider's
 * redirect URI, so it has to be). {@link OAuthSession.close} is mandatory — the
 * listener holds a port open until it runs.
 */
export interface OAuthSession {
  provider: OAuthClientProvider
  /** The bound loopback redirect URI, e.g. `http://127.0.0.1:53411/callback`. */
  redirectUrl: string
  /** Resolves with the authorization code once the browser comes back. */
  waitForCode: () => Promise<string>
  /** Stops the listener. Safe to call twice; call it in a `finally`. */
  close: () => void
}

/** The page the user is left looking at; inline-only so it needs no network. */
function resultPage(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center"><h1 style="font-size:1.1rem">${title}</h1><p style="color:#666">${detail}</p></body>`
}

/** A promise plus its settlers, so the listener can resolve a caller that hasn't arrived yet. */
interface Deferred {
  promise: Promise<string>
  resolve: (code: string) => void
  reject: (err: Error) => void
  settled: boolean
}

function deferred(): Deferred {
  const d = { settled: false } as Deferred
  d.promise = new Promise<string>((res, rej) => {
    d.resolve = (code) => {
      if (!d.settled) {
        d.settled = true
        res(code)
      }
    }
    d.reject = (err) => {
      if (!d.settled) {
        d.settled = true
        rej(err)
      }
    }
  })
  // A silent token refresh never awaits this, and `close()` rejects it on the way
  // out — without a handler that would surface as an unhandled rejection. This
  // attaches one to a *derived* promise, so a real awaiter still sees the error.
  d.promise.catch(() => {})
  return d
}

/**
 * Binds a loopback listener on an ephemeral port and starts capturing the
 * redirect immediately — the code can land before anyone awaits it, so the
 * deferred is created here, not in `waitForCode`.
 *
 * Only a request carrying `code` or `error` settles the flow; anything else
 * (a stray `/favicon.ico`, a port scan) gets a 404 and is ignored. `state` must
 * match the value we generated, so a different page on this machine can't
 * inject its own code.
 *
 * `preferredPort` is the port a previous successful sign-in used. RFC 8252 lets
 * a loopback client vary its port, but not every server honours that, so we try
 * to reuse the port the client was registered with and fall back to an ephemeral
 * one if it's taken.
 */
async function bindLoopback(
  state: string,
  preferredPort?: number
): Promise<{
  server: Server
  port: number
  result: Deferred
}> {
  const result = deferred()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (!code && !error) {
      res.writeHead(404).end()
      return
    }
    const send = (status: number, title: string, detail: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(resultPage(title, detail))
    }
    if (error) {
      send(400, 'Sign-in failed', 'You can close this tab and try again in Sylor.')
      result.reject(new Error(`Authorization was denied (${error}).`))
      return
    }
    if (url.searchParams.get('state') !== state) {
      send(400, 'Sign-in failed', 'The response did not match this request.')
      result.reject(new Error('Authorization response failed its state check; nothing was saved.'))
      return
    }
    send(200, 'Signed in', 'You can close this tab and go back to Sylor.')
    result.resolve(code as string)
  })
  const listenOn = (port: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const onError = (): void => resolve(false)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve(true)
      })
    })
  const bound = (preferredPort ? await listenOn(preferredPort) : false) || (await listenOn(0))
  const address = bound ? (server.address() as AddressInfo | null) : null
  if (!address || typeof address.port !== 'number') {
    server.close()
    throw new Error('Could not open a local port to complete sign-in.')
  }
  server.unref()
  return { server, port: address.port, result }
}

/**
 * The {@link OAuthClientProvider} the SDK drives. Everything durable goes through
 * {@link writeSlot} keyed by server name, so two OAuth servers never share a
 * token; the PKCE verifier deliberately lives only in this instance.
 */
class SylorOAuthProvider implements OAuthClientProvider {
  private verifier = ''

  constructor(
    private readonly server: string,
    private readonly store: string,
    private readonly redirect: string,
    private readonly stateValue: string,
    private readonly openExternal: (url: string) => void | Promise<void>
  ) {}

  get redirectUrl(): string {
    return this.redirect
  }

  /** A public client: no secret, PKCE only, one loopback redirect. */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Sylor',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    return this.stateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readStore(this.store).servers?.[this.server]?.client
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    writeSlot(this.store, this.server, { client: info })
  }

  tokens(): OAuthTokens | undefined {
    return readStore(this.store).servers?.[this.server]?.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    // A completed exchange also confirms this port works for this server, so it's
    // worth reusing next launch (see bindLoopback's preferredPort).
    const port = Number(new URL(this.redirect).port) || undefined
    writeSlot(this.store, this.server, port ? { tokens, port } : { tokens })
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('This sign-in attempt has no PKCE verifier; start again.')
    return this.verifier
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openExternal(authorizationUrl.toString())
  }

  /** Called when the server says a credential is stale; drop just that much. */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier' || scope === 'all') this.verifier = ''
    if (scope === 'tokens') clearSlot(this.store, this.server, ['tokens'])
    else if (scope === 'client') clearSlot(this.store, this.server, ['client'])
    else if (scope === 'all') clearSlot(this.store, this.server, [])
  }
}

/**
 * Prepares an OAuth attempt for `server`: binds the loopback catcher (reusing the
 * port a previous sign-in registered, if free) and returns the provider to pass as
 * the transport's `authProvider`.
 *
 * With valid tokens already on disk the SDK refreshes silently and no browser ever
 * opens — the listener is bound anyway because we can't know that in advance, and
 * it costs one ephemeral port for the length of the connect.
 */
export async function startOAuthSession(server: string, deps: OAuthDeps): Promise<OAuthSession> {
  const store = deps.storePath ?? mcpAuthPath()
  const state = randomBytes(16).toString('hex')
  const bound = await bindLoopback(state, readStore(store).servers?.[server]?.port)
  const redirect = `http://127.0.0.1:${bound.port}/callback`
  const provider = new SylorOAuthProvider(server, store, redirect, state, deps.openExternal)
  let timer: NodeJS.Timeout | null = null
  return {
    provider,
    redirectUrl: redirect,
    waitForCode: () => {
      // Armed on the first await, not at bind time, so a user who finishes the
      // consent screen slowly isn't racing a timer that started before they saw it.
      if (!timer && !bound.result.settled) {
        timer = setTimeout(
          () => bound.result.reject(new Error('Timed out waiting for sign-in to finish.')),
          deps.timeoutMs ?? AUTH_TIMEOUT_MS
        )
        timer.unref?.()
      }
      return bound.result.promise
    },
    close: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      bound.result.reject(new Error('Sign-in was cancelled.'))
      if (bound.server.listening) {
        bound.server.closeAllConnections?.()
        bound.server.close()
      }
    }
  }
}
