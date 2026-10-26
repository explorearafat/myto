import type { Provider } from '../providers/provider'
import type { ChatImage } from '../../shared/types'
import { Computer } from './computer'
import { readScreen, parseChatLines } from './vision'
import { buildToneProfile, composerSystemPrompt, loadToneProfile, saveToneProfile, type ToneMessage, type ToneProfile } from './tone'

/**
 * The messaging flow — the Assistant's #1 job, engineered for zero mistakes:
 *
 *   gather (screenshots of the open chat → vision → the last messages, in order)
 *     → tone profile (built from the last 2-4 days the same way, cached per contact)
 *     → compose (provider writes ONE draft under strict style rules)
 *     → DRAFT STOP. The app shows the draft; nothing leaves the machine until
 *       the user approves that exact text.
 *   deliver (approved draft): focus the chat window → clipboard set → Ctrl+V →
 *       optional Enter → verification screenshot. Paste, not SendKeys typing,
 *       so unicode Bangla never mangles and a 500-word message lands in ~40ms.
 */

export interface ChatContext {
  messages: ToneMessage[]
  rawRead: string
  capturesMs: number
}

export interface Draft {
  text: string
  toneApplied: boolean
  profile: ToneProfile | null
  context: ChatContext | null
}

export interface MessagingDeps {
  provider: Provider
  modelId: string
  computer: Computer
  /** Capture the full screen → base64 PNG. Injected: Electron's desktopCapturer in the app. */
  capture: () => Promise<ChatImage | null>
  /** The assistant data dir (tones live here). */
  dataDir: string
  now?: () => Date
}

/** How many fresh screenshots the context pass takes of the open chat. */
const CONTEXT_SHOTS = 3

/** The strict extraction question — its answer parses into ToneMessages. */
function contextQuestion(contact: string): string {
  return [
    `These screenshots show a chat conversation with ${contact}.`,
    'Read the visible messages IN ORDER, newest at the end, and output them EXACTLY in this format, one per line:',
    'THEM: <their message verbatim>',
    'ME: <my message verbatim>',
    'Rules: include every visible message from the last few screens; copy text EXACTLY (Bangla included);',
    'skip timestamps, names, read-receipts and UI labels; output ONLY the lines.'
  ].join(' ')
}

/** Read the open chat into structured messages via screenshots + vision. */
export async function gatherChatContext(deps: MessagingDeps, contact: string): Promise<ChatContext> {
  const t0 = Date.now()
  const images: ChatImage[] = []
  for (let i = 0; i < CONTEXT_SHOTS; i++) {
    const shot = await deps.capture()
    if (shot) images.push(shot)
    if (i < CONTEXT_SHOTS - 1) await new Promise((r) => setTimeout(r, 350))
  }
  const read = await readScreen(deps.provider, deps.modelId, images, contextQuestion(contact))
  if (!read.ok) throw new Error(read.text)
  return { messages: parseChatLines(read.text), rawRead: read.text, capturesMs: Date.now() - t0 }
}

/** Build (and cache) the tone profile for a contact from gathered context. */
export async function ensureToneProfile(deps: MessagingDeps, contact: string, context?: ChatContext): Promise<ToneProfile> {
  const existing = loadToneProfile(deps.dataDir, contact)
  const freshEnough = existing && Date.now() - new Date(existing.builtAt).getTime() < 3 * 24 * 3600 * 1000
  if (freshEnough && existing && existing.samplesCount >= 8) return existing
  const ctx = context ?? (await gatherChatContext(deps, contact))
  const profile = buildToneProfile(ctx.messages, deps.now?.() ?? new Date())
  saveToneProfile(deps.dataDir, contact, profile)
  return profile
}

/** Compose ONE draft reply in the user's exact tone. Nothing is sent here. */
export async function composeReply(deps: MessagingDeps, contact: string, intent: string): Promise<Draft> {
  const context = await gatherChatContext(deps, contact)
  const profile = await ensureToneProfile(deps, contact, context)
  const system = composerSystemPrompt(contact, profile, intent)
  const recent = context.messages
    .slice(-12)
    .map((m) => ({ role: (m.from === 'me' ? 'assistant' : 'user') as 'assistant' | 'user', content: m.text }))
  const messages = [
    { role: 'system' as const, content: system },
    ...recent,
    {
      role: 'user' as const,
      content: `Write the next message to ${contact} now. What it should say: ${intent}`
    }
  ]
  const text = (await deps.provider.getCompletion(deps.modelId, messages)).trim()
  return { text, toneApplied: true, profile, context }
}

/** Compose from text the user pasted (no screenshots) — the fallback path. */
export async function composeReplyFromHistory(deps: MessagingDeps, contact: string, intent: string, history: ToneMessage[]): Promise<Draft> {
  const profile = buildToneProfile(history, deps.now?.() ?? new Date())
  saveToneProfile(deps.dataDir, contact, profile)
  const system = composerSystemPrompt(contact, profile, intent)
  const recent = history.slice(-12).map((m) => ({ role: (m.from === 'me' ? 'assistant' : 'user') as 'assistant' | 'user', content: m.text }))
  const text = (await deps.provider.getCompletion(deps.modelId, [{ role: 'system' as const, content: system }, ...recent, { role: 'user' as const, content: intent }])).trim()
  return { text, toneApplied: true, profile, context: null }
}

export interface DeliveryResult {
  ok: boolean
  detail: string
  ms: number
}

/**
 * Deliver an APPROVED draft into the focused chat window: paste + optional
 * Enter, then a verification screenshot path. The caller owns the confirm step.
 */
export async function deliverDraft(deps: MessagingDeps, text: string, opts?: { windowTitle?: string; pressEnter?: boolean }): Promise<DeliveryResult> {
  const c = deps.computer
  const t0 = Date.now()
  if (opts?.windowTitle) {
    const focus = await c.windowFocus(opts.windowTitle)
    if (!focus.ok) return { ok: false, detail: `could not focus "${opts.windowTitle}": ${focus.detail}`, ms: Date.now() - t0 }
    await new Promise((r) => setTimeout(r, 250)) // let the window come forward
  }
  const pasted = await c.paste(text, opts?.pressEnter ?? true)
  if (!pasted.ok) return { ok: false, detail: `paste failed: ${pasted.detail}`, ms: Date.now() - t0 }
  return { ok: true, detail: 'delivered — verify the message in the app', ms: Date.now() - t0 }
}
