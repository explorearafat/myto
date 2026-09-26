/**
 * Track 2 (browser automation) — CDP orchestration. Turns the browser tools' intents
 * (navigate / snapshot / read / click / type) into Chrome DevTools Protocol calls on
 * top of the pure page-perception core in ./cowork-browser. Deliberately transport-
 * agnostic: it talks only to an abstract {@link CdpTransport}, so ONE orchestration
 * drives both browser targets (the in-app Electron WebContentsView debugger and the
 * user's real Chrome over a remote-debugging WebSocket) and — the reason it lives in
 * its own module — is unit-testable with a fake transport. The real transports import
 * electron / open sockets and can't run headless; they live in ./cowork-browser-runtime.ts.
 */

import {
  buildPageSnapshot,
  normalizeNavigationUrl,
  resolveRef,
  type AXNode,
  type ElementRef
} from './cowork-browser'

/** A live Chrome DevTools Protocol connection — the single primitive a target must provide. */
export interface CdpTransport {
  /** Send a CDP command and resolve to its (untyped) result object. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /**
   * Optionally block until the page finishes loading after a navigation. Supplied by
   * transports with a native load signal (Electron `did-finish-load`, CDP
   * `Page.loadEventFired`); omitted by the fake transport in tests, where navigate
   * resolves without waiting.
   */
  waitForLoad?(timeoutMs: number): Promise<void>
  /**
   * Optional diagnostic sink. The real transports point this at a per-run log file
   * (see cowork-browser-runtime.ts) so a blank window or an empty snapshot in the
   * packaged app leaves a trace we can read back — this half can't run headless, so
   * the log is the only window into it. Omitted by the fake transport in tests.
   */
  log?(msg: string): void
}

/** Give a navigation a bounded time to settle before we stop waiting for load. */
const LOAD_TIMEOUT_MS = 15_000
/** Cap browser_read output so a long article can't blow the model's context. */
const READ_MAX_CHARS = 8_000

/** Narrow an unknown CDP result to an object we can read fields off of. */
function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
}
/** Read a string field, or ''. */
function asString(x: unknown): string {
  return typeof x === 'string' ? x : ''
}
/** A one-line message for a thrown value, for the diagnostic log. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
/** A short human label for an element in a tool result (e.g. `button "Sign in"`). */
function describeEl(el: ElementRef): string {
  return el.name ? `${el.role} "${el.name}"` : el.role
}
/** Runs on the target element: scroll it into view, then click it. */
const CLICK_FN = "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.click(); }"
/** Runs on the target element: scroll it into view and focus it (no clearing — used for submit-only). */
const FOCUS_FN =
  "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus(); }"
/**
 * Runs on the target element with the text as its argument: focus it, replace any existing
 * content, and dispatch the events a modern (React/Vue) site listens for so the value actually
 * "sticks". CDP's `Input.insertText` alone is unreliable here — it types characters at the
 * caret but does not fire the `input`/`change` events framework-controlled fields need, and it
 * does nothing useful for a `contenteditable` compose box (Gmail body, WhatsApp/Messenger
 * message field). So we do the work in-page instead:
 *   • <input>/<textarea>: use the native value setter (React overrides the property, so a plain
 *     `this.value=…` is swallowed on re-render) then dispatch bubbling `input`+`change`.
 *   • contenteditable: select all + `execCommand('insertText')` (fires the proper beforeinput/
 *     input the editor expects); fall back to setting textContent + an `input` event.
 * This is what fixed "typing e giye stack hoye jacche" — the text now lands and registers.
 */
const TYPE_FN = `function(text){
  this.scrollIntoView({block:'center',inline:'center'});
  this.focus();
  var tag = this.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(this, text); } else { this.value = text; }
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (this.isContentEditable) {
    var sel = window.getSelection();
    if (sel) { try { sel.selectAllChildren(this); } catch (e) {} }
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      this.textContent = text;
      this.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if ('value' in this) {
    this.value = text;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
}`

/**
 * A single browser session for one Cowork run. Holds the latest snapshot's `ref → element`
 * map so click/type can resolve the refs the model saw, and composes every action out of
 * CDP commands sent through the injected {@link CdpTransport}. One instance is created
 * lazily per run (see provider-ipc's `getBrowser`) and disposed when the run ends.
 */
export class BrowserSession {
  private refs: Record<string, ElementRef> = {}
  private enabled = false

  constructor(private readonly cdp: CdpTransport) {}

  /** Turn on the CDP domains we need. Idempotent — the first call does the work. */
  private async ensureEnabled(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    // Page for navigation, DOM+Runtime to act on nodes, Accessibility for the snapshot tree.
    // Log each domain's outcome: on the packaged app a swallowed failure here is the
    // difference between a working browser and a silently blank one, and this is our
    // only window into it (see CdpTransport.log).
    for (const domain of ['Page', 'DOM', 'Runtime', 'Accessibility']) {
      try {
        await this.cdp.send(`${domain}.enable`)
        this.cdp.log?.(`${domain}.enable ok`)
      } catch (err) {
        this.cdp.log?.(`${domain}.enable FAILED: ${errText(err)}`)
      }
    }
  }

  /** Resolve a snapshot element to a live CDP object id we can call functions on. */
  private async resolveObjectId(el: ElementRef): Promise<string | null> {
    if (typeof el.backendDOMNodeId !== 'number') return null
    const res = asRecord(await this.cdp.send('DOM.resolveNode', { backendNodeId: el.backendDOMNodeId }))
    const object = asRecord(res.object)
    const objectId = asString(object.objectId)
    return objectId || null
  }
  /**
   * Navigate to `rawUrl` (a bare host becomes https://…; non-http(s) is refused), wait for
   * the load to settle, then hand back a fresh page snapshot so the model can act in one step.
   */
  async navigate(rawUrl: unknown): Promise<string> {
    const norm = normalizeNavigationUrl(rawUrl)
    if ('error' in norm) return norm.error
    await this.ensureEnabled()
    this.cdp.log?.(`navigate → ${norm.url}`)
    // Page.navigate returns { frameId, loaderId, errorText? }. A set errorText means the
    // load never started (bad DNS, refused connection, blocked scheme) — surface it
    // instead of pressing on to snapshot a blank page and reporting "Opened".
    const navRes = asRecord(await this.cdp.send('Page.navigate', { url: norm.url }))
    const errorText = asString(navRes.errorText)
    if (errorText) {
      this.cdp.log?.(`Page.navigate errorText: ${errorText}`)
      return `Couldn't open ${norm.url} — the browser reported "${errorText}". Check the URL and your connection, then try again.`
    }
    if (this.cdp.waitForLoad) await this.cdp.waitForLoad(LOAD_TIMEOUT_MS).catch(() => {})
    const snap = await this.snapshot()
    this.cdp.log?.(`navigate done, snapshot ${snap.length} chars`)
    return `Opened ${norm.url}\n\n${snap}`
  }

  /**
   * Grab the accessibility tree and render it as the compact ref-tagged outline the model
   * reads. Refreshes the session's ref map — refs from an older snapshot stop resolving.
   */
  async snapshot(): Promise<string> {
    await this.ensureEnabled()
    const res = asRecord(await this.cdp.send('Accessibility.getFullAXTree'))
    const nodes = (Array.isArray(res.nodes) ? res.nodes : []) as AXNode[]
    const { outline, refs } = buildPageSnapshot(nodes)
    this.refs = refs
    this.cdp.log?.(`snapshot: ${nodes.length} AX nodes → ${Object.keys(refs).length} refs, ${outline.length} chars`)
    return outline
  }
  /** Read the page's visible text (document body innerText), clipped so it can't flood context. */
  async readText(): Promise<string> {
    await this.ensureEnabled()
    const res = asRecord(
      await this.cdp.send('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText : ""',
        returnByValue: true
      })
    )
    const text = asString(asRecord(res.result).value).replace(/\n{3,}/g, '\n\n').trim()
    if (!text) return '(the page has no readable text — try browser_snapshot for its structure)'
    return text.length > READ_MAX_CHARS
      ? `${text.slice(0, READ_MAX_CHARS)}\n\n… (page text truncated at ${READ_MAX_CHARS} characters)`
      : text
  }

  /** Click the element a snapshot `ref` points at (after scrolling it into view). */
  async click(input: unknown): Promise<string> {
    const el = resolveRef(input, this.refs)
    if (typeof el === 'string') return el
    await this.ensureEnabled()
    const objectId = await this.resolveObjectId(el)
    if (!objectId) return `Can't act on ${describeEl(el)} — it is no longer on the page; take a fresh browser_snapshot.`
    await this.cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: CLICK_FN })
    return `Clicked ${describeEl(el)}. Take a browser_snapshot to see what changed.`
  }

  /** Type `text` into the field a snapshot `ref` points at; optionally press Enter to submit. */
  async type(input: unknown): Promise<string> {
    const el = resolveRef(input, this.refs)
    if (typeof el === 'string') return el
    const rec = asRecord(input)
    const text = asString(rec.text)
    if (!text && !rec.submit) return 'browser_type needs {"ref":"e3","text":"…"} (add "submit":true to press Enter).'
    await this.ensureEnabled()
    const objectId = await this.resolveObjectId(el)
    if (!objectId) return `Can't type into ${describeEl(el)} — it is no longer on the page; take a fresh browser_snapshot.`
    // Do the typing in-page (see TYPE_FN) so the value lands AND the site's input/change
    // handlers fire — CDP's Input.insertText alone doesn't register on framework-driven or
    // contenteditable fields. Submit-only (no text) just focuses, then Enter is synthesised.
    if (text) {
      await this.cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: TYPE_FN,
        arguments: [{ value: text }]
      })
    } else {
      await this.cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: FOCUS_FN })
    }
    if (rec.submit) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    }
    const did = text ? `Typed into ${describeEl(el)}` : `Pressed Enter in ${describeEl(el)}`
    return `${did}${rec.submit && text ? ' and pressed Enter' : ''}. Take a browser_snapshot to see the result.`
  }
}

