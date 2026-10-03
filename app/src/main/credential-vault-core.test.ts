import { describe, it, expect } from 'vitest'
import {
  slugifySite,
  commandPrograms,
  scopeMatches,
  envForCommand,
  redactSecrets,
  toMeta,
  serializeCredential,
  deserializeCredential,
  normalizeInput,
  isCredentialError,
  REDACTION_MASK,
  type StoredCredential
} from './credential-vault-core'

/**
 * Unit tests for the credential vault's PURE core (no Electron, no fs). These lock the
 * security-critical behaviour that the rest of the vault leans on: that a site name
 * becomes a safe slug, that a shell command's leading programs are found so scope
 * matching never over-injects, that merged env is deterministic with reported
 * collisions, that redaction masks a value AND its url-encoded form longest-first, that
 * {@link toMeta} never leaks a value, and that (de)serialization round-trips while a
 * tampered blob degrades to null rather than injecting junk.
 */

/** A ready-made stored credential for the merge/redact/meta cases. */
function cred(over: Partial<StoredCredential> = {}): StoredCredential {
  return {
    site: 'github',
    label: 'GitHub',
    env: { GH_TOKEN: 'ghp_secretvalue1234' },
    scopes: ['git', 'gh'],
    usageNote: 'push and gh',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over
  }
}

describe('slugifySite', () => {
  it('lowercases, replaces runs of non-alphanumerics with a dash, and trims dashes', () => {
    expect(slugifySite('  My Shop!! ')).toBe('my-shop')
    expect(slugifySite('GitHub')).toBe('github')
    expect(slugifySite('a.b_c/d')).toBe('a-b-c-d')
  })
  it('returns empty string for junk and caps length at 64', () => {
    expect(slugifySite('!!!')).toBe('')
    expect(slugifySite('')).toBe('')
    expect(slugifySite('x'.repeat(100)).length).toBe(64)
  })
})

describe('commandPrograms', () => {
  it('takes each segment leading program across &&, |, ;, newline', () => {
    expect(commandPrograms('git push && npm run build')).toEqual(['git', 'npm'])
    expect(commandPrograms('cat x | grep y ; echo done')).toEqual(['cat', 'grep', 'echo'])
  })
  it('skips env-assignment prefixes and wrapper keywords', () => {
    expect(commandPrograms('GH_TOKEN=x git push')).toEqual(['git'])
    expect(commandPrograms('sudo env FOO=1 vercel deploy')).toEqual(['vercel'])
  })
  it('reduces a path/quoted/.exe token to a bare program name and dedupes', () => {
    expect(commandPrograms('/usr/bin/git status && "git" log')).toEqual(['git'])
    expect(commandPrograms('C:\\tools\\gh.exe pr list')).toEqual(['gh'])
  })
  it('returns [] for empty or non-string input', () => {
    expect(commandPrograms('')).toEqual([])
    expect(commandPrograms('   ')).toEqual([])
    expect(commandPrograms(undefined as unknown as string)).toEqual([])
  })
})

describe('scopeMatches', () => {
  it('matches when any program is in scopes (scope tokens normalised too)', () => {
    expect(scopeMatches(['git'], ['git', 'gh'])).toBe(true)
    expect(scopeMatches(['npm'], ['git', 'gh'])).toBe(false)
    expect(scopeMatches(['gh'], ['/usr/bin/gh'])).toBe(true)
  })
  it('is false when either side is empty', () => {
    expect(scopeMatches([], ['git'])).toBe(false)
    expect(scopeMatches(['git'], [])).toBe(false)
  })
})

describe('envForCommand', () => {
  it('merges env of every credential whose scope matches a program in the command', () => {
    const creds = [
      cred(),
      cred({ site: 'vercel', env: { VERCEL_TOKEN: 'vt_abc12345' }, scopes: ['vercel'] })
    ]
    expect(envForCommand(creds, 'git push').env).toEqual({ GH_TOKEN: 'ghp_secretvalue1234' })
    expect(envForCommand(creds, 'vercel deploy').env).toEqual({ VERCEL_TOKEN: 'vt_abc12345' })
    // A command that matches neither service gets no injected secret.
    expect(envForCommand(creds, 'npm install').env).toEqual({})
  })
  it('first-writer wins on a name collision and the differing key is reported', () => {
    const creds = [
      cred({ site: 'a', env: { TOKEN: 'first-value' }, scopes: ['git'] }),
      cred({ site: 'b', env: { TOKEN: 'second-value' }, scopes: ['git'] })
    ]
    const { env, collisions } = envForCommand(creds, 'git push')
    expect(env.TOKEN).toBe('first-value')
    expect(collisions).toEqual(['TOKEN'])
  })
  it('an identical value on both credentials is not a collision', () => {
    const creds = [
      cred({ site: 'a', env: { TOKEN: 'same' }, scopes: ['git'] }),
      cred({ site: 'b', env: { TOKEN: 'same' }, scopes: ['git'] })
    ]
    expect(envForCommand(creds, 'git push').collisions).toEqual([])
  })
})

describe('redactSecrets', () => {
  it('masks each injected value with the redaction mask', () => {
    const out = redactSecrets('token is ghp_secretvalue1234 here', ['ghp_secretvalue1234'])
    expect(out).toBe(`token is ${REDACTION_MASK} here`)
    expect(out).not.toContain('ghp_secretvalue1234')
  })
  it('masks the percent-encoded form of a value too (URL in a remote or error)', () => {
    const secret = 'a b/c+d=e' // encodes to a%20b%2Fc%2Bd%3De
    const out = redactSecrets(`url https://x/${encodeURIComponent(secret)}/y`, [secret])
    expect(out).not.toContain(encodeURIComponent(secret))
    expect(out).toContain(REDACTION_MASK)
  })
  it('masks longest-first so a value that is a substring of another leaves no tail', () => {
    const out = redactSecrets('AAAABBBB and AAAA', ['AAAA', 'AAAABBBB'])
    expect(out).toBe(`${REDACTION_MASK} and ${REDACTION_MASK}`)
  })
  it('skips values shorter than the minimum so ordinary words survive', () => {
    expect(redactSecrets('set the env and go', ['env', 'set', 'go'])).toBe('set the env and go')
  })
  it('returns the text unchanged when there is nothing to mask', () => {
    expect(redactSecrets('plain text', [])).toBe('plain text')
    expect(redactSecrets('', ['ghp_secretvalue1234'])).toBe('')
  })
})

describe('toMeta', () => {
  it('strips values down to variable names, keeping scopes and usage', () => {
    const meta = toMeta(cred({ env: { GH_TOKEN: 'secret', GH_USER: 'me' } }))
    expect(meta).toEqual({
      site: 'github',
      label: 'GitHub',
      varNames: ['GH_TOKEN', 'GH_USER'],
      scopes: ['git', 'gh'],
      usageNote: 'push and gh'
    })
    expect(JSON.stringify(meta)).not.toContain('secret')
  })
})

describe('serialize / deserialize round-trip', () => {
  it('round-trips a credential through the version-tagged blob', () => {
    const original = cred()
    const back = deserializeCredential(serializeCredential(original))
    expect(back).toEqual(original)
  })
  it('returns null for malformed JSON, wrong shape, or a missing site/env', () => {
    expect(deserializeCredential('not json')).toBeNull()
    expect(deserializeCredential('{"v":1}')).toBeNull()
    expect(deserializeCredential(JSON.stringify({ v: 1, cred: { site: '' } }))).toBeNull()
    expect(deserializeCredential(JSON.stringify({ v: 1, cred: { site: 'x', env: {} } }))).toBeNull()
  })
  it('drops non-string env values and scopes from a tampered blob', () => {
    const tampered = JSON.stringify({
      v: 1,
      cred: { site: 'x', env: { OK: 'yes', BAD: 123 }, scopes: ['git', 7, null] }
    })
    const back = deserializeCredential(tampered)
    expect(back?.env).toEqual({ OK: 'yes' })
    expect(back?.scopes).toEqual(['git'])
  })
})

describe('normalizeInput', () => {
  const now = '2026-10-01T12:00:00.000Z'
  it('normalises a valid input and stamps createdAt', () => {
    const r = normalizeInput({ site: 'GitHub', env: { GH_TOKEN: 't0ken' }, scopes: ['Git'] }, now)
    expect(isCredentialError(r)).toBe(false)
    if (!isCredentialError(r)) {
      expect(r.site).toBe('github')
      expect(r.label).toBe('github')
      expect(r.scopes).toEqual(['git'])
      expect(r.createdAt).toBe(now)
    }
  })
  it('defaults scopes from the well-known service when none are given', () => {
    const r = normalizeInput({ site: 'vercel', env: { VERCEL_TOKEN: 'vt_abc12345' } }, now)
    if (!isCredentialError(r)) expect(r.scopes).toEqual(['vercel'])
  })
  it('defaults scopes to the slug for an unknown service', () => {
    const r = normalizeInput({ site: 'my-shop', env: { KEY: 'value123' } }, now)
    if (!isCredentialError(r)) expect(r.scopes).toEqual(['my-shop'])
  })
  it('errors (not throws) on a missing site or an empty env', () => {
    expect(isCredentialError(normalizeInput({ site: '', env: { K: 'v' } }, now))).toBe(true)
    expect(isCredentialError(normalizeInput({ site: 'x', env: {} }, now))).toBe(true)
    expect(isCredentialError(normalizeInput({ site: 'x', env: { K: '' } }, now))).toBe(true)
  })
})


