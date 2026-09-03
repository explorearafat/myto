/**
 * OAuth session tests.
 *
 * These exercise the real loopback listener over 127.0.0.1 (no network egress)
 * and a real credential file in a temp dir, because the two things worth proving
 * are exactly the ones a mock would paper over: that a redirect arriving at the
 * bound port is captured, and that a token written on one launch is found on the
 * next. The browser opener is the only injected seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpAuthPath, startOAuthSession, type OAuthSession } from '@main/mcp/oauth'

const dirs: string[] = []
const open: OAuthSession[] = []

/** A fresh store path in its own temp dir, cleaned up after each test. */
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sylor-oauth-'))
  dirs.push(dir)
  return join(dir, 'mcp-auth.json')
}

/** Starts a session and registers it for teardown (a live session holds a port). */
async function session(server: string, store: string, extra: { timeoutMs?: number } = {}) {
  const opener = vi.fn()
  const s = await startOAuthSession(server, { openExternal: opener, storePath: store, ...extra })
  open.push(s)
  return { s, opener }
}

/** GETs a URL and resolves its status code (used to play the browser's redirect). */
function hit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', reject)
  })
}

afterEach(() => {
  for (const s of open.splice(0)) s.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('startOAuthSession', () => {
  it('binds a loopback redirect URI the provider advertises', async () => {
    const { s } = await session('acme', storePath())
    expect(s.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(s.provider.redirectUrl).toBe(s.redirectUrl)
    expect(s.provider.clientMetadata.redirect_uris).toEqual([s.redirectUrl])
    expect(s.provider.clientMetadata.client_name).toBe('Sylor')
    // A public client: PKCE only, no secret to leak.
    expect(s.provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('opens the consent screen through the injected opener', async () => {
    const { s, opener } = await session('acme', storePath())
    await s.provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'))
    expect(opener).toHaveBeenCalledWith('https://auth.example.com/authorize?x=1')
  })

  it('captures the authorization code from the redirect', async () => {
    const { s } = await session('acme', storePath())
    const state = await s.provider.state?.()
    expect(await hit(`${s.redirectUrl}?code=abc123&state=${String(state)}`)).toBe(200)
    await expect(s.waitForCode()).resolves.toBe('abc123')
  })

  it('captures a code that arrives before anyone awaits it', async () => {
    // The transport throws UnauthorizedError only *after* the browser is opened,
    // so a fast user can beat the caller to waitForCode.
    const { s } = await session('acme', storePath())
    const state = await s.provider.state?.()
    await hit(`${s.redirectUrl}?code=early&state=${String(state)}`)
    await new Promise((r) => setTimeout(r, 10))
    await expect(s.waitForCode()).resolves.toBe('early')
  })

  it('rejects a response whose state does not match', async () => {
    const { s } = await session('acme', storePath())
    expect(await hit(`${s.redirectUrl}?code=abc&state=forged`)).toBe(400)
    await expect(s.waitForCode()).rejects.toThrow(/state check/)
  })

  it('rejects when the user denies consent', async () => {
    const { s } = await session('acme', storePath())
    expect(await hit(`${s.redirectUrl}?error=access_denied`)).toBe(400)
    await expect(s.waitForCode()).rejects.toThrow(/denied/)
  })

  it('ignores a request that carries neither code nor error', async () => {
    const { s } = await session('acme', storePath())
    expect(await hit(`http://127.0.0.1:${new URL(s.redirectUrl).port}/favicon.ico`)).toBe(404)
    const state = await s.provider.state?.()
    await hit(`${s.redirectUrl}?code=real&state=${String(state)}`)
    await expect(s.waitForCode()).resolves.toBe('real')
  })

  it('times out instead of waiting forever', async () => {
    const { s } = await session('acme', storePath(), { timeoutMs: 20 })
    await expect(s.waitForCode()).rejects.toThrow(/Timed out/)
  })

  it('reports cancellation once closed', async () => {
    const { s } = await session('acme', storePath())
    s.close()
    await expect(s.waitForCode()).rejects.toThrow(/cancelled/)
  })
})

describe('credential persistence', () => {
  it('round-trips tokens and a registered client, scoped per server', async () => {
    const store = storePath()
    const a = (await session('acme', store)).s
    const b = (await session('other', store)).s
    a.provider.saveTokens({ access_token: 'tok-a', token_type: 'bearer' })
    a.provider.saveClientInformation?.({ client_id: 'cid-a' })
    b.provider.saveTokens({ access_token: 'tok-b', token_type: 'bearer' })
    expect(await a.provider.tokens()).toMatchObject({ access_token: 'tok-a' })
    expect(await a.provider.clientInformation()).toMatchObject({ client_id: 'cid-a' })
    expect(await b.provider.tokens()).toMatchObject({ access_token: 'tok-b' })
    expect(await b.provider.clientInformation()).toBeUndefined()
  })

  it('finds a token a previous session saved (no browser on relaunch)', async () => {
    const store = storePath()
    const first = (await session('acme', store)).s
    first.provider.saveTokens({ access_token: 'kept', token_type: 'bearer' })
    first.close()
    const second = (await session('acme', store)).s
    expect(await second.provider.tokens()).toMatchObject({ access_token: 'kept' })
  })

  it('reuses the loopback port a successful sign-in registered', async () => {
    // Some servers pin the redirect URI they registered, so the port has to be
    // sticky rather than freshly ephemeral on every launch.
    const store = storePath()
    const first = (await session('acme', store)).s
    first.provider.saveTokens({ access_token: 't', token_type: 'bearer' })
    const port = new URL(first.redirectUrl).port
    first.close()
    const second = (await session('acme', store)).s
    expect(new URL(second.redirectUrl).port).toBe(port)
  })

  it('invalidates just the scope it is asked to', async () => {
    const store = storePath()
    const { s } = await session('acme', store)
    s.provider.saveTokens({ access_token: 't', token_type: 'bearer' })
    s.provider.saveClientInformation?.({ client_id: 'cid' })
    s.provider.invalidateCredentials?.('tokens')
    expect(await s.provider.tokens()).toBeUndefined()
    expect(await s.provider.clientInformation()).toMatchObject({ client_id: 'cid' })
    s.provider.invalidateCredentials?.('all')
    expect(await s.provider.clientInformation()).toBeUndefined()
  })

  it('keeps the PKCE verifier in memory only', async () => {
    const store = storePath()
    const { s } = await session('acme', store)
    s.provider.saveCodeVerifier('verifier-secret')
    expect(await s.provider.codeVerifier()).toBe('verifier-secret')
    s.provider.saveTokens({ access_token: 't', token_type: 'bearer' })
    expect(readFileSync(store, 'utf-8')).not.toContain('verifier-secret')
  })

  it('defaults the store to ~/.sylor/mcp-auth.json', () => {
    expect(mcpAuthPath().replace(/\\/g, '/')).toMatch(/\.sylor\/mcp-auth\.json$/)
  })
})
