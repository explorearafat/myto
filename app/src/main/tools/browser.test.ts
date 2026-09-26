import { describe, it, expect } from 'vitest'
import {
  browserAvailable,
  browserTools,
  browserNavigateTool,
  browserSnapshotTool,
  browserReadTool,
  browserClickTool,
  browserTypeTool
} from './browser'
import type { ToolContext, ToolGate } from './registry'
import type { BrowserSession } from '../cowork-browser-cdp'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { BrowserTarget, ProviderSettings } from '../../shared/types'

/** Settings with the browser armed at `target` and tool use on. */
const withTarget = (target: BrowserTarget): ProviderSettings => ({
  ...DEFAULT_PROVIDER_SETTINGS,
  tools: { enabled: true, codeExecution: false },
  cowork: { ...DEFAULT_PROVIDER_SETTINGS.cowork, browserTarget: target }
})

const coworkGate = (target: BrowserTarget): ToolGate => ({
  settings: withTarget(target),
  mode: 'cowork',
  workspaceDir: '/work'
})

/** A fake BrowserSession that records which method each tool called it through. */
function fakeSession(): { session: BrowserSession; calls: { method: string; arg: unknown }[] } {
  const calls: { method: string; arg: unknown }[] = []
  const session = {
    navigate: async (u: unknown) => (calls.push({ method: 'navigate', arg: u }), 'NAV'),
    snapshot: async () => (calls.push({ method: 'snapshot', arg: undefined }), 'SNAP'),
    readText: async () => (calls.push({ method: 'readText', arg: undefined }), 'READ'),
    click: async (i: unknown) => (calls.push({ method: 'click', arg: i }), 'CLICK'),
    type: async (i: unknown) => (calls.push({ method: 'type', arg: i }), 'TYPE')
  } as unknown as BrowserSession
  return { session, calls }
}

/** A ToolContext wired to a fake session (or none, to exercise the degraded path). */
function ctx(target: BrowserTarget, session?: BrowserSession): ToolContext {
  return {
    ...coworkGate(target),
    signal: new AbortController().signal,
    getBrowser: session ? async () => session : undefined
  }
}
describe('browserAvailable', () => {
  it('is true whenever a target other than off is armed, in Chat and Cowork', () => {
    expect(browserAvailable(coworkGate('in-app'))).toBe(true)
    expect(browserAvailable(coworkGate('system-chrome'))).toBe(true)
    expect(browserAvailable(coworkGate('off'))).toBe(false)
    // Now available in Chat too, so "control the browser" works in the mode the user is in.
    expect(browserAvailable({ ...coworkGate('in-app'), mode: 'chat' })).toBe(true)
    expect(browserAvailable({ ...coworkGate('off'), mode: 'chat' })).toBe(false)
  })
})

describe('browser tools', () => {
  it('exposes exactly the five tools, read/write split as expected', () => {
    expect(browserTools.map((t) => t.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_read',
      'browser_click',
      'browser_type'
    ])
    // navigate/snapshot/read are read-only (no prompt); click/type are exec (gated).
    expect(browserNavigateTool.sideEffect).toBeUndefined()
    expect(browserSnapshotTool.sideEffect).toBeUndefined()
    expect(browserReadTool.sideEffect).toBeUndefined()
    expect(browserClickTool.sideEffect).toBe('exec')
    expect(browserTypeTool.sideEffect).toBe('exec')
  })

  it('degrades to a note when no browser is wired into the context', async () => {
    const out = await browserSnapshotTool.run({}, ctx('in-app'))
    expect(out).toMatch(/not available here/)
    expect(out).toMatch(/Settings/)
  })

  it('routes each tool to the matching session method', async () => {
    const { session, calls } = fakeSession()
    expect(await browserNavigateTool.run({ url: 'example.com' }, ctx('in-app', session))).toBe('NAV')
    expect(await browserSnapshotTool.run({}, ctx('in-app', session))).toBe('SNAP')
    expect(await browserReadTool.run({}, ctx('in-app', session))).toBe('READ')
    expect(await browserClickTool.run({ ref: 'e1' }, ctx('in-app', session))).toBe('CLICK')
    expect(await browserTypeTool.run({ ref: 'e2', text: 'hi' }, ctx('in-app', session))).toBe('TYPE')
    expect(calls).toEqual([
      { method: 'navigate', arg: 'example.com' },
      { method: 'snapshot', arg: undefined },
      { method: 'readText', arg: undefined },
      { method: 'click', arg: { ref: 'e1' } },
      { method: 'type', arg: { ref: 'e2', text: 'hi' } }
    ])
  })
})
