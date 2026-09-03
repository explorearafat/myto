/**
 * What Sylor can do to a live web page, and how risky each one is.
 *
 * These are the raw action bodies — the in-page JS the agent's `browse` tool runs —
 * plus the classifiers that decide how hard the permission gate should bite. There
 * is deliberately no gate in this file: the engine's own permission system
 * (`workflow/permission.ts`) owns that decision, so this module stays pure and
 * testable with a fake {@link BrowserTarget}.
 *
 * Escalation by blast radius is baked into `classifyClick`, not left to the caller:
 * a click whose target reads like "Pay"/"Checkout" is re-classified as `payment`
 * (refused outright, never merely gated); "Send"/"Post" escalate to `send`;
 * "Delete"/"Remove" to `delete`. And typing into a password/secret field is refused
 * — credentials are the user's to enter, never Sylor's to fill.
 */
import type { BrowserAction } from '@shared/types'
import type { BrowserTarget } from './target'

/** Text on a control that means real money is about to move — always refused. */
export const PAYMENT_RE =
  /\b(pay|buy|checkout|check\s?out|place\s+order|purchase|subscribe|donate|order\s+now|confirm\s+(payment|purchase)|add\s+card|complete\s+order)\b/i
/** Text that posts/sends something outward (message, tweet, comment, submit). */
export const SEND_RE = /\b(send|post|tweet|reply|publish|comment|submit|share)\b/i
/** Text that destroys data. */
export const DELETE_RE = /\b(delete|remove|trash|deactivate|close\s+account|wipe|erase)\b/i
/** Field names/labels we refuse to auto-fill (credentials, card data, secrets). */
export const SENSITIVE_FIELD_RE = /pass|secret|token|cvv|cvc|card|ssn|otp|pin|credential/i

/** Classify a click by its target text, escalating to the strongest action class. */
export function classifyClick(label: string): BrowserAction {
  if (PAYMENT_RE.test(label)) return 'payment'
  if (DELETE_RE.test(label)) return 'delete'
  if (SEND_RE.test(label)) return 'send'
  return 'click'
}

/**
 * Coerce user/agent input into a loadable URL: pass through http(s), treat a bare
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

/** How an element was addressed: by the index a perception pass tagged, or by label. */
export type ElementRef = { kind: 'index'; idx: number } | { kind: 'label'; label: string }

/**
 * Read `target` as either a perceived index or a label to match.
 *
 * The model is told to use the index from the last read, but it will sometimes name
 * a button instead ("Compose"), and failing the whole step over that wastes a turn.
 */
export function parseRef(raw: string): ElementRef | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  const asIndex = /^#?(\d+)$/.exec(value)
  if (asIndex) return { kind: 'index', idx: Number(asIndex[1]) }
  return { kind: 'label', label: value }
}

/** A JS string literal for embedding in an in-page expression. */
function lit(value: string): string {
  return JSON.stringify(value)
}

/**
 * The element-finding preamble shared by click and type.
 *
 * By index it is an exact `data-sylor-idx` lookup. By label it prefers an exact
 * accessible-name match over a substring one, so "Send" does not hit "Resend" while
 * a partial label still works.
 */
function findExpression(ref: ElementRef): string {
  if (ref.kind === 'index') {
    return `var el = document.querySelector('[data-sylor-idx="${ref.idx}"]');`
  }
  return `
    var want = ${lit(ref.label)}.toLowerCase();
    var sel = 'a[href],button,input,textarea,select,summary,[role],[onclick],[tabindex]';
    var all = Array.prototype.slice.call(document.querySelectorAll(sel));
    function nameOf(n) {
      var s = n.getAttribute('aria-label') || n.getAttribute('title') ||
        n.getAttribute('placeholder') || n.value || n.textContent || '';
      return String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
    }
    var visible = all.filter(function (n) {
      var r = n.getBoundingClientRect();
      return r && (r.width > 0 || r.height > 0);
    });
    var el = visible.filter(function (n) { return nameOf(n) === want; })[0] ||
      visible.filter(function (n) { return nameOf(n).indexOf(want) !== -1; })[0] || null;`
}

/** Human description of a ref, for cards and refusal messages. */
export function describeRef(ref: ElementRef): string {
  return ref.kind === 'index' ? `element #${ref.idx}` : `"${ref.label}"`
}

/** Outcome of one raw action against the page. */
export type ActionOutcome =
  | { ok: true; detail: string }
  | { ok: false; reason: 'not-found' | 'refused' | 'error'; detail: string }

/** Load a URL, resolving once the navigation has been accepted. */
export async function navigate(target: BrowserTarget, rawUrl: string): Promise<ActionOutcome> {
  const url = normalizeUrl(rawUrl)
  if (!url) return { ok: false, reason: 'error', detail: 'No URL was given.' }
  try {
    await target.loadURL(url)
    return { ok: true, detail: `Loaded ${url}` }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) }
  }
}

/**
 * Click the element `ref` points at. Scrolls it into view first — a click on an
 * off-screen element is accepted by the DOM but is not what the user sees happen,
 * and some sites bind their handler to the scroll.
 */
export async function click(target: BrowserTarget, ref: ElementRef): Promise<ActionOutcome> {
  try {
    const found = await target.executeJavaScript(
      `(function () {
        ${findExpression(ref)}
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`
    )
    if (!found) return { ok: false, reason: 'not-found', detail: `${describeRef(ref)} is not on the page.` }
    return { ok: true, detail: `Clicked ${describeRef(ref)}.` }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) }
  }
}

/**
 * Type `value` into the field `ref` points at, optionally pressing Enter.
 *
 * The value is set through the prototype's setter and followed by `input` + `change`
 * events, because React and friends ignore a plain `el.value =`. The guest refuses a
 * password/hidden field itself — a second line of defence behind the executor's
 * {@link SENSITIVE_FIELD_RE} check, since a field's type is only knowable in the page.
 */
export async function type(
  target: BrowserTarget,
  ref: ElementRef,
  value: string,
  submit = false
): Promise<ActionOutcome> {
  try {
    const result = await target.executeJavaScript(
      `(function () {
        ${findExpression(ref)}
        if (!el) return false;
        if (el.type === 'password' || el.type === 'hidden') return 'sensitive';
        el.focus();
        var proto = Object.getPrototypeOf(el) || {};
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, ${lit(value)});
        else el.value = ${lit(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (${submit ? 'true' : 'false'}) {
          var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
          if (el.form && el.form.requestSubmit) el.form.requestSubmit();
        }
        return true;
      })()`
    )
    if (result === 'sensitive') {
      return {
        ok: false,
        reason: 'refused',
        detail: 'That is a password field. Sylor never types credentials — please type it yourself.'
      }
    }
    if (!result) return { ok: false, reason: 'not-found', detail: `${describeRef(ref)} is not on the page.` }
    return { ok: true, detail: `Typed into ${describeRef(ref)}${submit ? ' and pressed Enter' : ''}.` }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) }
  }
}

/**
 * Scroll one viewport-ish step.
 *
 * Instant, not smooth: a smooth scroll costs ~400ms of animation per step and the
 * next perception pass would capture the page mid-glide. Reporting how far it
 * actually moved also lets the agent see "the page didn't move" in the result,
 * instead of spending another step discovering that it is at the end.
 */
export async function scroll(
  target: BrowserTarget,
  direction: 'up' | 'down'
): Promise<ActionOutcome> {
  const dy = direction === 'down' ? 'window.innerHeight*0.8' : '-window.innerHeight*0.8'
  try {
    const moved = (await target.executeJavaScript(
      `(function () {
        var y0 = window.scrollY;
        window.scrollBy(0, ${dy});
        return Math.round(window.scrollY - y0);
      })()`
    )) as number
    const shifted = Math.abs(Number(moved) || 0)
    return {
      ok: true,
      detail: shifted
        ? `Scrolled ${direction} (${shifted}px).`
        : `Scrolled ${direction} but the page did not move — you are already at the ${direction === 'down' ? 'bottom' : 'top'}.`
    }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err) }
  }
}
