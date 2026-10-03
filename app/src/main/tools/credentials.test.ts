import { describe, expect, it } from 'vitest'
import {
  saveCredentialTool,
  listCredentialsTool,
  deleteCredentialTool,
  credentialTools
} from './credentials'
import type { ToolContext, ToolGate } from './registry'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import {
  normalizeInput,
  toMeta,
  slugifySite,
  isCredentialError,
  type StoredCredential
} from '../credential-vault-core'
import type { CredentialInput, CredentialMeta } from '../../shared/types'

/**
 * The credential TOOLS are the model-facing half of the vault. The cardinal rule under test:
 * a secret VALUE never appears in anything these tools return — save_credential echoes only
 * the variable NAMES and scopes it stored, list_credentials returns metadata only. We back
 * the ctx callbacks with an in-memory stand-in built on the SAME pure core (normalizeInput /
 * toMeta) the real safeStorage vault uses, so the tools see production semantics (slugging,
 * default scopes, a values-included store) without touching safeStorage or the filesystem.
 */

const SECRET = 'ghp_SuperSecretToken1234567890ABCDEF'

/** An in-memory vault whose store keeps VALUES, exactly like the real one — but no crypto/fs. */
function fakeVault() {
  const store = new Map<string, StoredCredential>()
  return {
    store,
    saveCredential(input: CredentialInput): CredentialMeta[] {
      const n = normalizeInput(input)
      if (isCredentialError(n)) throw new Error(n.error)
      store.set(n.site, n)
      return [...store.values()].map(toMeta)
    },
    listCredentialMeta(): CredentialMeta[] {
      return [...store.values()].map(toMeta)
    },
    deleteCredential(site: string): CredentialMeta[] {
      store.delete(slugifySite(site))
      return [...store.values()].map(toMeta)
    }
  }
}

/** A ToolContext wired to a fake vault; with no vault the credential callbacks stay absent. */
function ctx(vault?: ReturnType<typeof fakeVault>): ToolContext {
  return {
    settings: DEFAULT_PROVIDER_SETTINGS,
    mode: 'cowork',
    workspaceDir: 'C:/work',
    signal: new AbortController().signal,
    saveCredential: vault?.saveCredential,
    listCredentialMeta: vault?.listCredentialMeta,
    deleteCredential: vault?.deleteCredential
  }
}

describe('credential tools', () => {
  it('registers exactly the three vault tools, in order', () => {
    expect(credentialTools.map((t) => t.name)).toEqual([
      'save_credential',
      'list_credentials',
      'delete_credential'
    ])
  })

  it('are advertised only when a working folder scopes them', () => {
    const gate: ToolGate = { settings: DEFAULT_PROVIDER_SETTINGS, mode: 'cowork', workspaceDir: null }
    expect(saveCredentialTool.available(gate)).toBe(false)
    const scoped: ToolGate = { ...gate, workspaceDir: 'C:/work' }
    expect(saveCredentialTool.available(scoped)).toBe(true)
    expect(listCredentialsTool.available(scoped)).toBe(true)
    expect(deleteCredentialTool.available(scoped)).toBe(true)
  })

  it('save_credential stores the value but never echoes it back', async () => {
    const vault = fakeVault()
    const out = await saveCredentialTool.run(
      { site: 'github', env: { GH_TOKEN: SECRET }, usageNote: 'push + gh' },
      ctx(vault)
    )
    expect(out).not.toContain(SECRET) // the value never surfaces
    expect(out).toContain('GH_TOKEN') // the NAME does
    expect(out).toContain('git') // default scopes for github
    expect(out).toContain('gh')
    // and the value really was stored, unredacted, in the values-included vault
    expect(vault.store.get('github')?.env.GH_TOKEN).toBe(SECRET)
  })

  it('defaults scopes by service when none are given', async () => {
    const vault = fakeVault()
    await saveCredentialTool.run({ site: 'vercel', env: { VERCEL_TOKEN: SECRET } }, ctx(vault))
    expect(vault.store.get('vercel')?.scopes).toEqual(['vercel'])
  })

  it('list_credentials returns names + scopes, never a value', async () => {
    const vault = fakeVault()
    await saveCredentialTool.run({ site: 'github', env: { GH_TOKEN: SECRET } }, ctx(vault))
    const out = await listCredentialsTool.run({}, ctx(vault))
    expect(out).toContain('github')
    expect(out).toContain('GH_TOKEN')
    expect(out).not.toContain(SECRET)
  })

  it('list_credentials reports an empty vault plainly', async () => {
    expect(await listCredentialsTool.run({}, ctx(fakeVault()))).toMatch(/no credentials/i)
  })

  it('delete_credential removes one site and reports the remainder', async () => {
    const vault = fakeVault()
    await saveCredentialTool.run({ site: 'github', env: { GH_TOKEN: SECRET } }, ctx(vault))
    await saveCredentialTool.run({ site: 'vercel', env: { VERCEL_TOKEN: SECRET } }, ctx(vault))
    const out = await deleteCredentialTool.run({ site: 'github' }, ctx(vault))
    expect(out).toMatch(/deleted the "github"/i)
    expect(vault.store.has('github')).toBe(false)
    expect(vault.store.has('vercel')).toBe(true)
  })

  it('validates input before ever touching the vault', async () => {
    const vault = fakeVault()
    expect(await saveCredentialTool.run({ env: { GH_TOKEN: SECRET } }, ctx(vault))).toMatch(
      /needs a "site"/i
    )
    expect(await saveCredentialTool.run({ site: 'github' }, ctx(vault))).toMatch(/needs an "env"/i)
    expect(await deleteCredentialTool.run({}, ctx(vault))).toMatch(/needs the "site"/i)
    expect(vault.store.size).toBe(0) // nothing stored on a rejected input
  })

  it('degrades to a plain note when the vault runtime is absent', async () => {
    expect(
      await saveCredentialTool.run({ site: 'github', env: { GH_TOKEN: SECRET } }, ctx())
    ).toMatch(/isn't available/i)
    expect(await listCredentialsTool.run({}, ctx())).toMatch(/isn't available/i)
    expect(await deleteCredentialTool.run({ site: 'github' }, ctx())).toMatch(/isn't available/i)
  })

  it('surfaces a vault refusal (e.g. safeStorage unavailable) without leaking the value', async () => {
    const out = await saveCredentialTool.run(
      { site: 'github', env: { GH_TOKEN: SECRET } },
      {
        ...ctx(),
        saveCredential: () => {
          throw new Error('Secure storage is unavailable on this system')
        }
      }
    )
    expect(out).toMatch(/save_credential failed/i)
    expect(out).toContain('Secure storage is unavailable')
    expect(out).not.toContain(SECRET)
  })
})

