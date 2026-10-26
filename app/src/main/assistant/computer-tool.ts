import { join } from 'node:path'
import { app } from 'electron'
import type { ToolContext, ToolDef, ToolGate } from '../tools/registry'
import { Computer } from './computer'
import { isAccepted, loadPolicyState, revokeAcceptance, saveAcceptance, policyText, POLICY_VERSION } from './policy'

/**
 * The Assistant's agent-side tool: when the policy is accepted, the Myto agent
 * in chat can drive the computer itself — open apps and sites, read the active
 * window, move/click the mouse, press keys, paste text — as a `computer` tool
 * alongside its file tools. Registered as an EXTENSION tool (not a built-in) so
 * the built-in catalogue snapshot never changes and turning the assistant off
 * removes the tool entirely.
 */

export type AssistantStatus = {
  accepted: boolean
  policyVersion: number
  platform: string
  hostReady: boolean
  policy: string
}

/** Singleton controller for the app's lifetime. */
let computer: Computer | null = null
let registered = false
let registerFn: ((tool: ToolDef) => void) | null = null
let unregisterFn: ((name: string) => void) | null = null

/** userData dir — injectable for tests, real Electron path in the app. */
function dataDir(): string {
  return join(app.getPath('userData'), 'assistant')
}

export function dataRoot(): string {
  return dataDir()
}

export function assistantStatus(): AssistantStatus {
  const state = loadPolicyState(dataDir())
  return {
    accepted: isAccepted(state),
    policyVersion: POLICY_VERSION,
    platform: process.platform,
    hostReady: computer?.ready ?? false,
    policy: policyText()
  }
}

/** The strict gate: nothing assistant-y runs without an accepted policy. */
export function isAssistantOn(): boolean {
  return isAccepted(loadPolicyState(dataDir()))
}

/** Agree to the policy → warm the host, register the agent tool. */
export async function acceptPolicy(): Promise<AssistantStatus> {
  saveAcceptance(dataDir())
  await ensureComputer()
  return assistantStatus()
}

/** Turn the assistant off: release the host, unregister the agent tool. */
export function disableAssistant(): AssistantStatus {
  revokeAcceptance(dataDir())
  computer?.stop()
  computer = null
  if (registered && unregisterFn) {
    unregisterFn('assistant__computer')
    registered = false
  }
  return assistantStatus()
}

export function setToolRegistrar(register: (tool: ToolDef) => void, unregister: (name: string) => void): void {
  registerFn = register
  unregisterFn = unregister
}

async function ensureComputer(): Promise<Computer> {
  if (!computer) computer = new Computer()
  await computer.warmup()
  if (!registered && registerFn) {
    registerFn(computerTool)
    registered = true
  }
  return computer
}

/** Shared instance for the IPC handlers (messaging, learning). */
export async function getComputer(): Promise<Computer> {
  return ensureComputer()
}

const ACTIONS = 'open | key | type | paste | click | doubleclick | rightclick | move | scroll | clipboard-get | clipboard-set | window-list | window-focus | active-window'

export const computerTool: ToolDef = {
  name: 'assistant__computer',
  description:
    'Use the computer like the user does: open an app/URL/file ({"action":"open","text":"notepad"}), read the active window title, move/click the mouse, press key combos, and paste text into the focused app (paste is instant and unicode-safe — prefer it over type for anything longer than a word). Only runs when the Assistant policy is accepted.',
  usage: '{"action": "paste", "text": "kemon acho?", "pressEnter": true} — actions: ' + ACTIONS,
  sideEffect: 'exec',
  available: (gate: ToolGate) => gate.mode === 'cowork' && isAssistantOn(),
  async run(input: unknown, _ctx: ToolContext): Promise<string> {
    if (!isAssistantOn()) return 'The Assistant is off — the user must accept the computer-use policy in Settings → Assistant.'
    const c = await getComputer()
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const action = String(o.action ?? '')
    const text = typeof o.text === 'string' ? o.text : undefined
    const num = (k: string): number | undefined => (typeof o[k] === 'number' ? (o[k] as number) : undefined)
    try {
      switch (action) {
        case 'open': {
          if (!text) return 'open needs {"text": "app name, URL or file path"}'
          return done(await c.open(text))
        }
        case 'key': {
          const keys = typeof o.keys === 'string' ? o.keys : text
          if (!keys) return 'key needs {"keys": "ctrl+s"}'
          return done(await c.key(keys))
        }
        case 'type':
          if (!text) return 'type needs {"text": "..."} (use paste for long text)'
          return done(await c.type(text))
        case 'paste': {
          if (!text) return 'paste needs {"text": "..."}'
          return done(await c.paste(text, o.pressEnter === true))
        }
        case 'click':
        case 'doubleclick':
        case 'rightclick': {
          const x = num('x')
          const y = num('y')
          if (x === undefined || y === undefined) return `${action} needs {"x": 100, "y": 200}`
          return done(await c.click(x, y, action === 'click' ? 'left' : action === 'doubleclick' ? 'double' : 'right'))
        }
        case 'move': {
          const x = num('x')
          const y = num('y')
          if (x === undefined || y === undefined) return 'move needs {"x": 100, "y": 200}'
          return done(await c.move(x, y))
        }
        case 'scroll':
          return done(await c.scroll(num('notches') ?? 3))
        case 'clipboard-set':
          if (!text) return 'clipboard-set needs {"text": "..."}'
          return done(await c.clipboardSet(text))
        case 'clipboard-get': {
          const r = await c.clipboardGet()
          return r.ok ? `Clipboard:\n${r.detail}` : `clipboard-get failed: ${r.detail}`
        }
        case 'window-list': {
          const r = await c.windowList()
          return r.ok ? `Windows:\n${(r.data as string[]).map((w) => '- ' + w).join('\n')}` : `window-list failed: ${r.detail}`
        }
        case 'window-focus': {
          if (!text) return 'window-focus needs {"text": "part of the window title"}'
          return done(await c.windowFocus(text))
        }
        case 'active-window': {
          const r = await c.activeWindow()
          return r.ok ? `Active window: ${r.detail}` : 'could not read the active window'
        }
        default:
          return `Unknown action "${action}". Actions: ${ACTIONS}`
      }
    } catch (err) {
      return `computer action failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

function done(r: { ok: boolean; detail: string; ms: number }): string {
  return r.ok ? `${r.detail} (${r.ms}ms)` : `failed (${r.ms}ms): ${r.detail}`
}
