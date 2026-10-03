import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Tests for the credential vault's ELECTRON half with a FAKE `safeStorage` (Vitest has no
 * real DPAPI). The fake makes encryption reversible but visibly non-plaintext, so these
 * can prove: a saved blob is encrypted on disk and git-ignored, reads return metadata with
 * no values, scoped env resolves only for matching programs, delete removes a site, and —
 * the security backstop — a save REFUSES when encryption is unavailable, writing nothing.
 */

// A mutable flag the "encryption unavailable" test flips; hoisted so the vi.mock factory
// (itself hoisted above imports) can close over it without a TDZ error.
const crypto = vi.hoisted(() => ({ available: true }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => crypto.available,
    // A recognizable, reversible stand-in for DPAPI — NOT real encryption, but the payload
    // is base64'd so the on-disk bytes are provably not the plaintext secret (the whole point
    // of the at-rest check below), while an `enc::` tag still marks it as "ours".
    encryptString: (s: string) => Buffer.from(`enc::${Buffer.from(s, 'utf-8').toString('base64')}`, 'utf-8'),
    decryptString: (b: Buffer) => {
      const t = b.toString('utf-8')
      if (!t.startsWith('enc::')) throw new Error('not decryptable here')
      return Buffer.from(t.slice('enc::'.length), 'base64').toString('utf-8')
    }
  }
}))

import {
  saveCredential,
  listCredentials,
  listCredentialMeta,
  deleteCredential,
  resolveEnvForCommand,
  ensureGitignored
} from './credential-vault'

let dir: string
beforeEach(async () => {
  crypto.available = true
  dir = await mkdtemp(join(tmpdir(), 'myto-vault-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('save → read', () => {
  it('stores an encrypted blob, git-ignores the store, and never leaks a value in meta', async () => {
    const meta = saveCredential(dir, {
      site: 'GitHub',
      env: { GH_TOKEN: 'ghp_supersecretvalue' },
      scopes: ['git', 'gh'],
      usageNote: 'push + gh'
    })
    // The returned meta carries names + scopes, never the value.
    expect(meta).toHaveLength(1)
    expect(meta[0]).toMatchObject({ site: 'github', varNames: ['GH_TOKEN'], scopes: ['git', 'gh'] })
    expect(JSON.stringify(meta)).not.toContain('ghp_supersecretvalue')

    // The on-disk blob is bytes, and the raw plaintext secret is NOT present in it.
    const blob = await readFile(join(dir, '.data', 'github', 'credential.enc'))
    expect(blob.includes('ghp_supersecretvalue')).toBe(false)
    expect(blob.toString('utf-8').startsWith('enc::')).toBe(true)

    // .gitignore now covers the store.
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf-8')
    expect(gitignore).toMatch(/^\.data\/$/m)

    // Main-process read decrypts back to the value; metadata read withholds it.
    expect(listCredentials(dir)[0].env.GH_TOKEN).toBe('ghp_supersecretvalue')
    expect(listCredentialMeta(dir)[0].varNames).toEqual(['GH_TOKEN'])
  })

  it('defaults scopes from the service when none are supplied', () => {
    saveCredential(dir, { site: 'vercel', env: { VERCEL_TOKEN: 'vt_abc12345' } })
    expect(listCredentialMeta(dir)[0].scopes).toEqual(['vercel'])
  })
})

describe('resolveEnvForCommand — scoped injection', () => {
  beforeEach(() => {
    saveCredential(dir, { site: 'github', env: { GH_TOKEN: 'ghp_supersecretvalue' }, scopes: ['git', 'gh'] })
    saveCredential(dir, { site: 'vercel', env: { VERCEL_TOKEN: 'vt_abc12345' }, scopes: ['vercel'] })
  })
  it('injects only the credential whose scope matches the command program', () => {
    expect(resolveEnvForCommand(dir, 'git push origin main')).toEqual({ GH_TOKEN: 'ghp_supersecretvalue' })
    expect(resolveEnvForCommand(dir, 'vercel deploy --prod')).toEqual({ VERCEL_TOKEN: 'vt_abc12345' })
  })
  it('returns undefined for a command that matches no credential (e.g. npm install)', () => {
    expect(resolveEnvForCommand(dir, 'npm install')).toBeUndefined()
  })
})

describe('delete', () => {
  it('removes one site and leaves the rest', () => {
    saveCredential(dir, { site: 'github', env: { GH_TOKEN: 'ghp_supersecretvalue' } })
    saveCredential(dir, { site: 'vercel', env: { VERCEL_TOKEN: 'vt_abc12345' } })
    const after = deleteCredential(dir, 'github')
    expect(after.map((m) => m.site)).toEqual(['vercel'])
  })
})

describe('encryption unavailable — refuse, never plaintext', () => {
  it('throws and writes nothing when safeStorage is unavailable', () => {
    crypto.available = false
    expect(() => saveCredential(dir, { site: 'github', env: { GH_TOKEN: 'ghp_supersecretvalue' } })).toThrow(
      /Secure storage is unavailable/
    )
    expect(listCredentials(dir)).toEqual([])
  })
})

describe('resilience', () => {
  it('skips a blob that will not decrypt here (foreign machine / corrupt), not throwing', async () => {
    saveCredential(dir, { site: 'github', env: { GH_TOKEN: 'ghp_supersecretvalue' } })
    // Overwrite one site's blob with bytes the fake decryptor rejects.
    await writeFile(join(dir, '.data', 'github', 'credential.enc'), Buffer.from('garbage-from-another-machine'))
    expect(listCredentials(dir)).toEqual([])
  })
  it('does not duplicate an existing .gitignore entry', async () => {
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n.data/\n', 'utf-8')
    ensureGitignored(dir)
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf-8')
    expect(gitignore.match(/\.data\//g)).toHaveLength(1)
  })
})

