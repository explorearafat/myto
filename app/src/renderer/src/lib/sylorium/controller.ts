/**
 * Sylorium action controller (requirements 12–14).
 *
 * The single choke point through which Sylor (the AI) drives the live browser.
 * Every action is classified into a {@link SyloriumAction} and run through the
 * permission gate BEFORE it touches the page, so the AI can never silently do
 * something sensitive:
 *   - `allow` → run it.
 *   - `ask`   → surface an approval request and wait for the user's yes.
 *   - `block` → refuse outright.
 *
 * Escalation by blast radius is baked in, not left to the caller: a click whose
 * target reads like "Pay"/"Checkout" is re-classified as `payment` (blocked by
 * default and never silently allowed); "Send"/"Post" clicks escalate to `send`;
 * "Delete"/"Remove" to `delete`. And the controller flatly refuses to type into
 * password/sensitive fields — credentials are the user's to enter, never the AI's
 * to fill (requirement 14).
 *
 * The user always keeps direct control of the same webview; this controller is
 * purely additive (requirement 13).
 */
import type { SyloriumAction, SyloriumPermission } from '@shared/types'
import type { WebviewElement } from '@renderer/types/webview'
import { perceivePage, type PerceptionSnapshot } from './perception'

/** Text on a control that means real money is about to move — always gated hard. */
const PAYMENT_RE = /\b(pay|buy|checkout|check\s?out|place\s+order|purchase|subscribe|donate|order\s+now|confirm\s+(payment|purchase)|add\s+card|complete\s+order)\b/i
/** Text that posts/sends something outward (message, tweet, comment, submit). */
const SEND_RE = /\b(send|post|tweet|reply|publish|comment|submit|share)\b/i
/** Text that destroys data. */
const DELETE_RE = /\b(delete|remove|trash|deactivate|close\s+account|wipe|erase)\b/i
/** Field names/labels we refuse to auto-fill (credentials, card data, secrets). */
const SENSITIVE_FIELD_RE = /pass|secret|token|cvv|cvc|card|ssn|otp|pin|credential/i

/** How the controller resolves + escalates a permission decision. */
export interface ControllerDeps {
  /** The live browser element to drive (null when no tab is ready). */
  getWebview: () => WebviewElement | null
  /** Current policy for an action class (from the persisted store). */
  getPermission: (action: SyloriumAction) => SyloriumPermission
  /** Ask the user to approve one `ask`-gated action; resolves true when approved. */
  requestApproval: (action: SyloriumAction, detail: string) => Promise<boolean>
  /** Optional activity log so the UI can show what the AI just did. */
  onActivity?: (message: string) => void
}

/** Outcome of a gated action. */
export type ActionResult =
  | { ok: true; detail: string; snapshot?: PerceptionSnapshot }
  | {
      ok: false
      reason: 'blocked' | 'denied' | 'no-webview' | 'not-found' | 'error'
      detail: string
    }

export class SyloriumController {
  constructor(private readonly deps: ControllerDeps) {}

  /** Resolve the permission for an action, prompting the user when it's `ask`. */
  private async gate(action: SyloriumAction, detail: string): Promise<ActionResult | null> {
    const policy = this.deps.getPermission(action)
    if (policy === 'block') {
      this.deps.onActivity?.(`Refused ${action}: blocked by policy (${detail}).`)
      return { ok: false, reason: 'blocked', detail: `"${action}" is blocked in Sylorium settings.` }
    }
    if (policy === 'ask') {
      const approved = await this.deps.requestApproval(action, detail)
      if (!approved) {
        this.deps.onActivity?.(`Declined ${action}: ${detail}.`)
        return { ok: false, reason: 'denied', detail: 'You declined this action.' }
      }
    }
    return null // null === cleared to proceed
  }

  private wv(): WebviewElement | null {
    return this.deps.getWebview()
  }

  /** Read/observe the current page (DOM → a11y → vision). Gated as `read`. */
  async perceive(preferVision = false): Promise<ActionResult> {
    const denied = await this.gate('read', 'read page content')
    if (denied) return denied
    const wv = this.wv()
    if (!wv) return { ok: false, reason: 'no-webview', detail: 'No active tab.' }
    const snapshot = await perceivePage(wv, { preferVision })
    this.deps.onActivity?.(`Read page (${snapshot.mode}): ${snapshot.title || snapshot.url}`)
    return { ok: true, detail: `Perceived via ${snapshot.mode}.`, snapshot }
  }

  /** Navigate the active tab to a URL. Gated as `navigate`. */
  async navigate(rawUrl: string): Promise<ActionResult> {
    const url = normalizeUrl(rawUrl)
    if (!url) return { ok: false, reason: 'error', detail: 'Not a valid URL.' }
    const denied = await this.gate('navigate', `go to ${url}`)
    if (denied) return denied
    const wv = this.wv()
    if (!wv) return { ok: false, reason: 'no-webview', detail: 'No active tab.' }
    try {
      await wv.loadURL(url)
      this.deps.onActivity?.(`Navigated to ${url}`)
      return { ok: true, detail: `Loaded ${url}` }
    } catch (e) {
      return { ok: false, reason: 'error', detail: String(e) }
    }
  }

  /**
   * Click the element previously tagged `data-sylor-idx={idx}` by a perception
   * pass. The action class is escalated from the element's own text: a "Pay"
   * button is gated as `payment`, "Send"/"Post" as `send`, "Delete" as `delete`,
   * everything else as a plain `click`.
   */
  async click(idx: number, label = ''): Promise<ActionResult> {
    const action = classifyClick(label)
    const denied = await this.gate(action, label ? `click "${label}"` : `click element #${idx}`)
    if (denied) return denied
    const wv = this.wv()
    if (!wv) return { ok: false, reason: 'no-webview', detail: 'No active tab.' }
    try {
      const ok = await wv.executeJavaScript(
        `(function () {
          var el = document.querySelector('[data-sylor-idx="${idx}"]');
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`
      )
      if (!ok) return { ok: false, reason: 'not-found', detail: `Element #${idx} is gone.` }
      this.deps.onActivity?.(`Clicked ${label || `element #${idx}`} (${action}).`)
      return { ok: true, detail: `Clicked ${label || `#${idx}`}.` }
    } catch (e) {
      return { ok: false, reason: 'error', detail: String(e) }
    }
  }

  /**
   * Type `value` into the field tagged `data-sylor-idx={idx}`. Gated as `fill`.
   * Refuses password / card / secret fields outright — the AI never fills
   * credentials (requirement 14); the user types those themselves.
   */
  async type(idx: number, value: string, label = ''): Promise<ActionResult> {
    if (SENSITIVE_FIELD_RE.test(label)) {
      this.deps.onActivity?.(`Refused to fill a sensitive field: ${label}.`)
      return {
        ok: false,
        reason: 'blocked',
        detail: 'Refused to auto-fill a password/credential field — please type it yourself.'
      }
    }
    const denied = await this.gate('fill', label ? `type into "${label}"` : `type into #${idx}`)
    if (denied) return denied
    const wv = this.wv()
    if (!wv) return { ok: false, reason: 'no-webview', detail: 'No active tab.' }
    try {
      const payload = JSON.stringify(value)
      const ok = await wv.executeJavaScript(
        `(function () {
          var el = document.querySelector('[data-sylor-idx="${idx}"]');
          if (!el) return false;
          if (el.type === 'password' || el.type === 'hidden') return 'sensitive';
          el.focus();
          var setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
          if (setter && setter.set) setter.set.call(el, ${payload});
          else el.value = ${payload};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`
      )
      if (ok === 'sensitive')
        return { ok: false, reason: 'blocked', detail: 'Refused to fill a password field.' }
      if (!ok) return { ok: false, reason: 'not-found', detail: `Field #${idx} is gone.` }
      this.deps.onActivity?.(`Typed into ${label || `#${idx}`}.`)
      return { ok: true, detail: `Filled ${label || `#${idx}`}.` }
    } catch (e) {
      return { ok: false, reason: 'error', detail: String(e) }
    }
  }

  /** Scroll the page (read affordance). Gated as `read`. */
  async scroll(direction: 'up' | 'down'): Promise<ActionResult> {
    const denied = await this.gate('read', `scroll ${direction}`)
    if (denied) return denied
    const wv = this.wv()
    if (!wv) return { ok: false, reason: 'no-webview', detail: 'No active tab.' }
    const dy = direction === 'down' ? 'window.innerHeight*0.8' : '-window.innerHeight*0.8'
    try {
      await wv.executeJavaScript(`window.scrollBy({ top: ${dy}, behavior: 'smooth' })`)
      return { ok: true, detail: `Scrolled ${direction}.` }
    } catch (e) {
      return { ok: false, reason: 'error', detail: String(e) }
    }
  }
}

/** Classify a click by its target text, escalating to the strongest action class. */
export function classifyClick(label: string): SyloriumAction {
  if (PAYMENT_RE.test(label)) return 'payment'
  if (DELETE_RE.test(label)) return 'delete'
  if (SEND_RE.test(label)) return 'send'
  return 'click'
}

/**
 * Coerce user/AI input into a loadable URL: pass through http(s), treat a bare
 * host as https, and turn anything else into a web search. Returns '' when even
 * that fails (empty input).
 */
export function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(value) && !value.includes(' ')) return `https://${value}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}
