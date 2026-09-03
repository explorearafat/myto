/**
 * Live-page perception for the renderer-owned `<webview>` (the live preview).
 *
 * The engine's `browse` tool has its own copy of this ladder in
 * `main/browser/perception.ts`, because the page it drives is main-owned; this one
 * serves `preview_inspect`, whose page is a `<webview>` only the renderer can
 * reach. Keep the two in step when changing what the model gets to see.
 *
 * Sylor understands a live web page through a strict priority ladder:
 *   1. DOM        — structured extraction of visible text + interactive elements.
 *   2. Accessibility — the ARIA role/name tree, when the DOM has little plain text
 *      but is semantically rich (SPA widgets, canvas-with-aria apps).
 *   3. Vision     — a full-page screenshot handed to a vision model, used ONLY
 *      when the first two come back empty (canvas games, cross-origin frames).
 *
 * Vision is deliberately the last resort, never the default — it is the slowest,
 * least precise, and most privacy-exposing path.
 *
 * SECURITY: perception NEVER reads secrets. It does not
 * touch `document.cookie`, `localStorage`, or `sessionStorage`, and it never
 * returns the *value* of any input — so passwords, tokens, card numbers, and
 * private field contents are structurally impossible to leak to the model. Only
 * an element's label/role/type is surfaced, which is all the AI needs to reason
 * about where to click or type.
 */
import type { WebviewElement } from '@renderer/types/webview'

/** Which perception path produced a snapshot (in priority order). */
export type PerceptionMode = 'dom' | 'accessibility' | 'vision'

/** One interactive/landmark element the AI can reason about or target. */
export interface PerceivedElement {
  /** Stable index for this scan; the controller acts on the element by this id. */
  idx: number
  /** Lowercased tag name (a, button, input, …). */
  tag: string
  /** ARIA (or implicit) role, e.g. 'button', 'link', 'textbox'. */
  role: string
  /** Accessible name: label / aria-label / trimmed text (bounded, never a value). */
  name: string
  /** Input type for form controls ('password'/'hidden' are flagged, never valued). */
  type?: string
  /** True when the element accepts typed input (text field / textarea / editable). */
  editable?: boolean
  /** True when disabled/aria-disabled (so the AI doesn't try to click it). */
  disabled?: boolean
}

/** A single perception result: what Sylor "sees" on the page right now. */
export interface PerceptionSnapshot {
  mode: PerceptionMode
  url: string
  title: string
  /** Bounded visible text (empty for a pure vision snapshot). */
  text: string
  /** Interactive/landmark elements, in document order (empty for vision). */
  elements: PerceivedElement[]
  /** A `data:image/png;base64,…` screenshot — only set when `mode === 'vision'`. */
  imageDataUrl?: string
  /** True when `text`/`elements` were clipped at the capture cap. */
  truncated?: boolean
}

/** Caps that keep a snapshot context-safe (never dump a whole huge page). */
const MAX_TEXT = 12_000
const MAX_ELEMENTS = 200

/**
 * The in-page scan, as a self-contained expression string run in the guest via
 * `executeJavaScript`. Returns a JSON-serializable snapshot, or null on any
 * error (so the caller falls through to the next perception mode).
 *
 * `wantText` distinguishes the DOM pass (visible innerText) from the a11y pass
 * (role tree only). Neither ever reads a field value, a cookie, or storage.
 */
function scanExpression(wantText: boolean, maxText: number, maxElements: number): string {
  return `(function () {
    try {
      var SENSITIVE = /pass|secret|token|cvv|cvc|card|ssn|otp|pin/i;
      function accName(el) {
        var n = el.getAttribute('aria-label') ||
          (el.getAttribute('aria-labelledby') &&
            (document.getElementById(el.getAttribute('aria-labelledby')) || {}).textContent) ||
          el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
        if (!n && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') n = el.textContent || '';
        n = (n || '').replace(/\\s+/g, ' ').trim();
        return n.length > 140 ? n.slice(0, 140) + '…' : n;
      }
      function roleOf(el) {
        var r = el.getAttribute('role');
        if (r) return r;
        var t = el.tagName.toLowerCase();
        if (t === 'a') return 'link';
        if (t === 'button') return 'button';
        if (t === 'textarea') return 'textbox';
        if (t === 'select') return 'combobox';
        if (t === 'input') {
          var it = (el.getAttribute('type') || 'text').toLowerCase();
          if (it === 'checkbox' || it === 'radio' || it === 'button' || it === 'submit') return it;
          return 'textbox';
        }
        return t;
      }
      var sel = 'a[href],button,input,textarea,select,summary,[role],[onclick],[tabindex]';
      var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
      var elements = [];
      var idx = 0;
      var truncated = false;
      for (var i = 0; i < nodes.length; i++) {
        if (elements.length >= ${maxElements}) { truncated = true; break; }
        var el = nodes[i];
        var rect = el.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) continue; // skip hidden
        var style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        el.setAttribute('data-sylor-idx', String(idx));
        var tag = el.tagName.toLowerCase();
        var type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
        var editable = tag === 'textarea' ||
          (tag === 'input' && ['text','search','email','url','tel','number','password',''].indexOf(type) !== -1) ||
          el.isContentEditable;
        var name = accName(el);
        // Never surface a value; only note that a field is sensitive so the AI
        // (and the permission layer) treat it with care.
        if (type === 'password' || type === 'hidden' || SENSITIVE.test(el.name || el.id || name)) {
          name = name ? '[sensitive] ' + name : '[sensitive field]';
        }
        elements.push({
          idx: idx, tag: tag, role: roleOf(el), name: name,
          type: type, editable: !!editable,
          disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')
        });
        idx++;
      }
      var text = '';
      if (${wantText ? 'true' : 'false'}) {
        text = (document.body ? document.body.innerText : '') || '';
        text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
        if (text.length > ${maxText}) { text = text.slice(0, ${maxText}); truncated = true; }
      }
      return {
        url: location.href,
        title: document.title || '',
        text: text,
        elements: elements,
        truncated: truncated
      };
    } catch (e) {
      return null;
    }
  })()`
}

/** Shape returned by the in-guest scan (before we tag it with a mode). */
type RawScan = Omit<PerceptionSnapshot, 'mode'> | null

/** Run one scan pass in the guest; returns null if the guest threw or is blank. */
async function runScan(
  webview: WebviewElement,
  wantText: boolean
): Promise<RawScan> {
  try {
    const result = (await webview.executeJavaScript(
      scanExpression(wantText, MAX_TEXT, MAX_ELEMENTS)
    )) as RawScan
    return result ?? null
  } catch {
    return null
  }
}

/** True when a scan carries enough signal to be worth returning at its tier. */
function hasSignal(scan: RawScan, needText: boolean): boolean {
  if (!scan) return false
  if (needText) return scan.text.trim().length > 40 || scan.elements.length > 0
  return scan.elements.length > 0
}

/**
 * Perceive the page through the DOM → accessibility → vision ladder and return
 * the first mode that yields real signal. `preferVision` forces the screenshot
 * path (used when the model explicitly needs pixels). Callers get exactly one
 * snapshot, tagged with the mode that produced it.
 */
export async function perceivePage(
  webview: WebviewElement,
  opts: { preferVision?: boolean } = {}
): Promise<PerceptionSnapshot> {
  const baseUrl = safeUrl(webview)

  if (!opts.preferVision) {
    // 1. DOM: visible text + interactive elements.
    const dom = await runScan(webview, true)
    if (hasSignal(dom, true)) return { mode: 'dom', ...(dom as Omit<PerceptionSnapshot, 'mode'>) }

    // 2. Accessibility: role/name tree when plain text was thin but structure exists.
    const a11y = await runScan(webview, false)
    if (hasSignal(a11y, false))
      return { mode: 'accessibility', ...(a11y as Omit<PerceptionSnapshot, 'mode'>) }
  }

  // 3. Vision: last resort — a screenshot for a vision model. Honest fallback,
  // never the default. If the capture itself fails we return an empty vision
  // snapshot rather than throwing, so the caller always gets a usable result.
  return {
    mode: 'vision',
    url: baseUrl,
    title: safeTitle(webview),
    text: '',
    elements: [],
    imageDataUrl: await captureDataUrl(webview)
  }
}

/** Snapshot the guest as a PNG data URL, or undefined if the capture failed. */
async function captureDataUrl(webview: WebviewElement): Promise<string | undefined> {
  try {
    const image = await webview.capturePage()
    if (image.isEmpty()) return undefined
    return image.toDataURL()
  } catch {
    return undefined
  }
}

function safeUrl(webview: WebviewElement): string {
  try {
    return webview.getURL()
  } catch {
    return ''
  }
}

function safeTitle(webview: WebviewElement): string {
  try {
    return webview.getTitle()
  } catch {
    return ''
  }
}
