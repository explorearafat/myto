import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Assistant's consent gate — nothing else in this module tree runs before
 * the user agrees to the policy once, in the app. The accepted policy VERSION is
 * stored in userData (`assistant/policy.json`); bumping POLICY_VERSION re-arms
 * the gate so material changes re-ask. Pure cores are separated from the fs
 * wrapper so tests drive them without touching disk.
 */

/** Bump when the policy's meaning changes — users are re-asked on next launch. */
export const POLICY_VERSION = 1

/** The human policy the user agrees to. Shown verbatim in the Assistant pane. */
export function policyText(): string {
  return [
    'Myto Assistant — computer use policy',
    '',
    '1. Scope. With the Assistant on, Myto may use this computer the way you do:',
    '   open apps and websites, read the screen, move the mouse, type, and use',
    '   the clipboard — on every file and folder your account can reach.',
    '2. You stay in charge. Every chat-driven action still follows your permission',
    '   mode (ask first, or auto-approve). Assistant runs you start from the',
    '   Assistant pane always show their steps.',
    '3. Messages and email are confirm-first. A draft is always shown to you;',
    '   nothing is sent to another person until you approve that exact draft.',
    '4. No secrets out. The Assistant never reads password managers, wallet apps,',
    '   or credential stores, and never types stored passwords anywhere.',
    '5. Learning stays local. Screen captures and learned step lists are saved',
    '   only on this machine, and never uploaded except to the model endpoint you',
    '   configured, to complete the task you asked for.',
    '6. Stop anytime. Turning the Assistant off releases every control it holds.',
    '   Closing the app stops all automation instantly.'
  ].join('\n')
}

export interface PolicyState {
  acceptedVersion: number
  acceptedAt: string
}

/** Pure: is the gate open for this stored state (or undefined when unset)? */
export function isAccepted(state: PolicyState | null | undefined, version = POLICY_VERSION): boolean {
  return state !== null && state !== undefined && state.acceptedVersion >= version
}

/** Pure: the state record an acceptance writes. */
export function acceptRecord(version = POLICY_VERSION, now = new Date()): PolicyState {
  return { acceptedVersion: version, acceptedAt: now.toISOString() }
}

/** Pure: reject only when the gate is closed. Kept total for UI branches. */
export function needsConsent(state: PolicyState | null | undefined, version = POLICY_VERSION): boolean {
  return !isAccepted(state, version)
}

// ── Disk wrapper ─────────────────────────────────────────────────────────────

/** The assistant's data root inside userData — policy, tones, skills live here. */
export function assistantDir(userDataDir: string): string {
  return join(userDataDir, 'assistant')
}

function policyPath(userDataDir: string): string {
  return join(assistantDir(userDataDir), 'policy.json')
}

/** Read the stored acceptance, or null when never accepted / unreadable. */
export function loadPolicyState(userDataDir: string): PolicyState | null {
  try {
    if (!existsSync(policyPath(userDataDir))) return null
    const raw = JSON.parse(readFileSync(policyPath(userDataDir), 'utf8')) as Partial<PolicyState>
    if (typeof raw.acceptedVersion !== 'number') return null
    return { acceptedVersion: raw.acceptedVersion, acceptedAt: String(raw.acceptedAt ?? '') }
  } catch {
    return null
  }
}

/** Persist an acceptance; returns the state written. */
export function saveAcceptance(userDataDir: string, version = POLICY_VERSION, now = new Date()): PolicyState {
  const dir = assistantDir(userDataDir)
  mkdirSync(dir, { recursive: true })
  const state = acceptRecord(version, now)
  writeFileSync(policyPath(userDataDir), JSON.stringify(state, null, 2) + '\n', 'utf8')
  return state
}

/** Withdraw consent (the pane's "Turn off assistant") — the gate closes. */
export function revokeAcceptance(userDataDir: string): void {
  try {
    const p = policyPath(userDataDir)
    if (existsSync(p)) writeFileSync(p, JSON.stringify({ acceptedVersion: 0, acceptedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  } catch {
    // A failed revoke must never crash the app; the in-memory flag still turns it off.
  }
}
