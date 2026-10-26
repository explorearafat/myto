import { describe, it, expect } from 'vitest'
import { isAccepted, needsConsent, acceptRecord, POLICY_VERSION, loadPolicyState, saveAcceptance, revokeAcceptance, assistantDir } from './policy'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('policy gate (pure)', () => {
  it('is closed until the user accepts, and opens after', () => {
    expect(needsConsent(null)).toBe(true)
    expect(needsConsent(undefined)).toBe(true)
    expect(isAccepted(acceptRecord())).toBe(true)
    expect(needsConsent(acceptRecord())).toBe(false)
  })
  it('re-arms when the policy version is bumped', () => {
    const old = acceptRecord(POLICY_VERSION - 1)
    expect(isAccepted(old, POLICY_VERSION)).toBe(false)
    expect(needsConsent(old, POLICY_VERSION)).toBe(true)
  })
  it('a revoked (0) acceptance never reopens the gate', () => {
    expect(isAccepted({ acceptedVersion: 0, acceptedAt: '' })).toBe(false)
  })
})

describe('policy storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myto-policy-'))
  it('persists an acceptance and reads it back', () => {
    expect(loadPolicyState(dir)).toBeNull()
    const saved = saveAcceptance(dir)
    expect(saved.acceptedVersion).toBe(POLICY_VERSION)
    const loaded = loadPolicyState(dir)
    expect(loaded?.acceptedVersion).toBe(POLICY_VERSION)
    expect(revokeAcceptance(dir)).toBeUndefined()
    expect(isAccepted(loadPolicyState(dir))).toBe(false)
  })
  it('keeps everything under the assistant subfolder', () => {
    expect(assistantDir(dir).endsWith('assistant')).toBe(true)
  })
})
