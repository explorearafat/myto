/**
 * Preview inspector (Phase 2) — the renderer half of the `preview_inspect` tool.
 *
 * The live preview is a RENDERER-owned `<webview>` (see PreviewPanel.tsx), so the
 * coding engine (main process) cannot drive it directly. Instead it posts a
 * {@link PreviewInspectRequest} over IPC; this module — which holds the live
 * webview element — runs the requested browser-verification action and replies
 * with a {@link PreviewInspectResponse}. It is the mirror of the engine's
 * controller/perception, but for the app's own dev preview rather than the web.
 *
 * The actions mirror the CC preview_* tools:
 *   - `snapshot`     — accessibility/DOM listing (text + interactive elements).
 *   - `screenshot`   — a PNG of the rendered page (handed to the vision model).
 *   - `inspect`      — computed styles + box of one element (verify colors/size).
 *   - `console_logs` — recent guest console output (spot runtime errors).
 *   - `network`      — resource-timing entries (spot failed/slow requests).
 *   - `click`/`fill` — drive an interaction, then the engine re-snapshots.
 *   - `resize`       — emulate a mobile/tablet/custom viewport.
 *   - `eval`         — run an expression in the guest and report its value: the
 *                      escape hatch for everything the fixed actions don't cover
 *                      (hover, keys, scroll, app state, calling page functions).
 *   - `navigate`     — aim the preview at another loopback page, or reload it.
 *
 * `server_logs` is the one action that never reaches here: the dev server's output
 * lives in the main process, so the engine answers it there without a round-trip.
 *
 * SECURITY: like the browse executor, `fill` refuses password/credential
 * fields outright — verification never types secrets. `navigate` is confined to
 * loopback, so the guest (and therefore `eval`) can only ever reach the user's own
 * running app; the real web stays behind the separately gated `browse` tool.
 * Everything here observes or drives the local preview; nothing touches disk.
 */
import type { WebviewElement } from '@renderer/types/webview'
import type { PreviewInspectRequest, PreviewInspectResponse } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'
import { perceivePage } from './perception'

/** A reply minus the correlation id (the IPC handler re-attaches `requestId`). */
type InspectReply = Omit<PreviewInspectResponse, 'requestId'>

/** Caps that keep a reply context-safe (never dump an unbounded page). */
const MAX_OUTPUT = 8_000
const MAX_CONSOLE = 200
const MAX_NETWORK = 120

/** Hosts the preview is allowed to load — loopback only, in every form. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

/** How long a navigation may take to settle before we report what we have. */
const SETTLE_TIMEOUT_MS = 8_000
/** How often to re-check `isLoading()` while a navigation settles. */
const SETTLE_POLL_MS = 50
/** Beat to let a same-page reload actually start before polling for its end. */
const RELOAD_GRACE_MS = 150
/** Guest-side cap on a formatted `eval` value, so no page ships a megabyte over IPC. */
const MAX_EVAL_CHARS = 20_000

/** Field names/labels we refuse to auto-fill — mirrors the browse executor. */
const SENSITIVE_FIELD_RE = /pass|secret|token|cvv|cvc|card|ssn|otp|pin|credential/i

/** Viewport sizes for the responsive presets (desktop clears emulation). */
const PRESET_SIZES: Record<'mobile' | 'tablet', { w: number; h: number }> = {
  mobile: { w: 375, h: 812 },
  tablet: { w: 768, h: 1024 }
}

// ── Module state: the live webview + a rolling console buffer ──
let webview: WebviewElement | null = null
let consoleBuffer: { level: string; text: string }[] = []
let detachConsole: (() => void) | null = null
let initialized = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for a navigation to come to rest and return the guest that is live
 * afterwards.
 *
 * `before` is the element held when the navigation was requested. Aiming the
 * preview goes through the store, and the panel remounts the guest on a URL change
 * (`key={url}`), so the element we end up with is usually a NEW one — hence the
 * poll re-reads the module ref each tick instead of closing over it, and waits for
 * a different element rather than trusting `isLoading()` on the outgoing one. A
 * same-element reload passes `before: null` (nothing to outlive) plus a short
 * grace period, since `isLoading()` is still false for the first tick after
 * `reload()` and would otherwise read as "already settled". On timeout the live
 * guest is returned anyway: reporting a slow page beats reporting nothing.
 */
async function settle(before: WebviewElement | null, graceMs = 0): Promise<WebviewElement | null> {
  if (graceMs > 0) await sleep(graceMs)
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const el = webview
    if (el && el !== before && !el.isLoading()) return el
    await sleep(SETTLE_POLL_MS)
  }
  return webview
}

/** Clip long output to the cap, flagging truncation. */
function clip(text: string): { output: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { output: text, truncated: false }
  return { output: text.slice(0, MAX_OUTPUT) + '\n…(truncated)', truncated: true }
}

/**
 * Normalize a `console-message` level to a word. Electron has shipped both a
 * numeric level (0 verbose · 1 info · 2 warning · 3 error) and, more recently, a
 * string level; accept either so the buffer is version-agnostic.
 */
function levelName(raw: unknown): string {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase()
    if (s.startsWith('warn')) return 'warning'
    if (s.startsWith('err')) return 'error'
    if (s.startsWith('info')) return 'info'
    if (s.startsWith('debug') || s.startsWith('verbose')) return 'debug'
    return 'log'
  }
  if (raw === 3) return 'error'
  if (raw === 2) return 'warning'
  if (raw === 1) return 'info'
  return 'log'
}

/** True when a buffered level passes the requested filter. */
function levelPasses(level: string, filter: 'all' | 'error' | 'warn' | undefined): boolean {
  if (!filter || filter === 'all') return true
  if (filter === 'error') return level === 'error'
  // 'warn' → warnings and errors (the noteworthy ones).
  return level === 'error' || level === 'warning'
}

/**
 * Attach a `console-message`/navigation listener pair to `el`, feeding the ring
 * buffer. Returns a disposer that detaches both. The buffer is cleared on a fresh
 * load so stale messages from a previous page never mislead a verification.
 */
function attachConsole(el: WebviewElement): () => void {
  const onMessage = (event: Event): void => {
    const e = event as unknown as { level?: unknown; message?: string }
    consoleBuffer.push({ level: levelName(e.level), text: String(e.message ?? '') })
    if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift()
  }
  const onLoad = (): void => {
    consoleBuffer = []
  }
  el.addEventListener('console-message', onMessage as EventListener)
  el.addEventListener('did-start-loading', onLoad as EventListener)
  return () => {
    el.removeEventListener('console-message', onMessage as EventListener)
    el.removeEventListener('did-start-loading', onLoad as EventListener)
  }
}

/**
 * Register (or clear) the live preview webview. Called from PreviewPanel's ref;
 * because the panel remounts the guest on URL change, this may be invoked many
 * times — each swap re-attaches the console listener and resets the buffer.
 */
export function setPreviewWebview(el: WebviewElement | null): void {
  if (el === webview) return
  detachConsole?.()
  detachConsole = null
  consoleBuffer = []
  webview = el
  if (el) detachConsole = attachConsole(el)
}

/** A structured accessibility/DOM listing of the page (verify content/layout). */
async function doSnapshot(el: WebviewElement): Promise<InspectReply> {
  const snap = await perceivePage(el)
  const header = `# ${snap.title || '(untitled)'}\n${snap.url}\nperceived via ${snap.mode}\n`
  const elements = snap.elements
    .map((e) => `[${e.idx}] ${e.role}${e.disabled ? ' (disabled)' : ''} "${e.name}"`)
    .join('\n')
  const body = [
    header,
    elements ? `\n## Elements (${snap.elements.length})\n${elements}` : '',
    snap.text ? `\n## Text\n${snap.text}` : ''
  ].join('')
  const { output, truncated } = clip(body.trim())
  return {
    ok: true,
    output: output || '(page is empty)',
    truncated: truncated || !!snap.truncated,
    summary: `${snap.elements.length} elements · ${snap.mode}`,
    // A pure-vision snapshot already carries a screenshot — surface it too.
    media: snap.imageDataUrl ? toMedia(snap.imageDataUrl) : undefined
  }
}

/** A PNG of the rendered page, handed to the engine's vision path. */
async function doScreenshot(el: WebviewElement): Promise<InspectReply> {
  try {
    const image = await el.capturePage()
    if (image.isEmpty()) {
      return { ok: false, output: 'Screenshot was empty.', truncated: false, summary: 'empty', error: 'empty capture' }
    }
    const media = toMedia(image.toDataURL())
    if (!media) {
      return { ok: false, output: 'Could not encode the screenshot.', truncated: false, summary: 'encode failed', error: 'encode failed' }
    }
    return { ok: true, output: 'Captured a screenshot of the live preview.', truncated: false, summary: 'screenshot', media }
  } catch (e) {
    return { ok: false, output: String(e), truncated: false, summary: 'error', error: String(e) }
  }
}

/** Computed styles + box of one element (verify colors, fonts, spacing, size). */
async function doInspect(el: WebviewElement, selector: string, styles?: string[]): Promise<InspectReply> {
  const wanted = JSON.stringify(styles && styles.length ? styles : null)
  const sel = JSON.stringify(selector)
  const raw = (await el.executeJavaScript(`(function () {
    try {
      var el = document.querySelector(${sel});
      if (!el) return null;
      var cs = getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      var keys = ${wanted} || ['color','background-color','font-size','font-family','font-weight','display','width','height','margin','padding'];
      var styles = {};
      for (var i = 0; i < keys.length; i++) styles[keys[i]] = cs.getPropertyValue(keys[i]);
      var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        tagName: el.tagName.toLowerCase(), id: el.id || '',
        className: (typeof el.className === 'string' ? el.className : '') || '',
        text: text.length > 200 ? text.slice(0, 200) + '…' : text,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        styles: styles
      };
    } catch (e) { return null; }
  })()`)) as null | {
    tagName: string; id: string; className: string; text: string
    box: { x: number; y: number; width: number; height: number }
    styles: Record<string, string>
  }
  if (!raw) {
    return { ok: false, output: `No element matched "${selector}".`, truncated: false, summary: 'not found', error: 'not found' }
  }
  const styleLines = Object.entries(raw.styles).map(([k, v]) => `  ${k}: ${v}`).join('\n')
  const idPart = raw.id ? `#${raw.id}` : ''
  const classPart = raw.className ? `.${raw.className.trim().split(/\s+/).join('.')}` : ''
  const output = [
    `<${raw.tagName}${idPart}${classPart}>`,
    raw.text ? `text: "${raw.text}"` : '',
    `box: ${raw.box.width}×${raw.box.height} @ (${raw.box.x}, ${raw.box.y})`,
    `styles:\n${styleLines}`
  ].filter(Boolean).join('\n')
  const { output: clipped, truncated } = clip(output)
  return { ok: true, output: clipped, truncated, summary: `${raw.tagName}${idPart} · ${raw.box.width}×${raw.box.height}` }
}

/** Recent guest console output, filtered by level. */
function doConsole(filter: 'all' | 'error' | 'warn' | undefined): InspectReply {
  const kept = consoleBuffer.filter((m) => levelPasses(m.level, filter))
  if (kept.length === 0) {
    const scope = filter === 'error' ? 'errors' : filter === 'warn' ? 'warnings/errors' : 'messages'
    return { ok: true, output: `No console ${scope} recorded.`, truncated: false, summary: `0 ${scope}` }
  }
  const text = kept.map((m) => `[${m.level}] ${m.text}`).join('\n')
  const { output, truncated } = clip(text)
  const errors = kept.filter((m) => m.level === 'error').length
  return { ok: true, output, truncated, summary: `${kept.length} logs${errors ? ` · ${errors} errors` : ''}` }
}

/** Resource-timing entries from the guest (spot failed/slow requests). */
async function doNetwork(el: WebviewElement, filter: 'all' | 'failed' | undefined): Promise<InspectReply> {
  const raw = (await el.executeJavaScript(`(function () {
    try {
      var entries = performance.getEntriesByType('resource');
      var out = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        out.push({
          name: e.name, type: e.initiatorType, duration: Math.round(e.duration),
          size: e.transferSize || 0,
          status: (typeof e.responseStatus === 'number') ? e.responseStatus : null
        });
      }
      var nav = performance.getEntriesByType('navigation')[0];
      return { entries: out, docStatus: (nav && typeof nav.responseStatus === 'number') ? nav.responseStatus : null };
    } catch (e) { return null; }
  })()`)) as null | {
    entries: { name: string; type: string; duration: number; size: number; status: number | null }[]
    docStatus: number | null
  }
  if (!raw) {
    return { ok: false, output: 'Could not read network timing from the preview.', truncated: false, summary: 'unavailable', error: 'no timing' }
  }
  const failed = (s: number | null): boolean => s !== null && s >= 400
  let rows = raw.entries
  if (filter === 'failed') rows = rows.filter((r) => failed(r.status))
  const capped = rows.slice(0, MAX_NETWORK)
  const lines = capped.map(
    (r) => `${r.status ?? '—'} ${r.type} ${r.duration}ms ${r.size ? `${r.size}b ` : ''}${r.name}`
  )
  const header = raw.docStatus !== null ? `document: ${raw.docStatus}\n` : ''
  const body = header + (lines.length ? lines.join('\n') : filter === 'failed' ? 'No failed requests.' : 'No requests recorded.')
  const { output, truncated } = clip(body)
  const failedCount = raw.entries.filter((r) => failed(r.status)).length
  return {
    ok: true,
    output,
    truncated: truncated || rows.length > capped.length,
    summary: `${raw.entries.length} requests${failedCount ? ` · ${failedCount} failed` : ''}`
  }
}

/** Click the element matching `selector`, then let the engine re-snapshot. */
async function doClick(el: WebviewElement, selector: string): Promise<InspectReply> {
  const sel = JSON.stringify(selector)
  const res = (await el.executeJavaScript(`(function () {
    try {
      var el = document.querySelector(${sel});
      if (!el) return 'not-found';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'ok';
    } catch (e) { return 'error'; }
  })()`)) as string
  if (res === 'not-found') {
    return { ok: false, output: `No element matched "${selector}".`, truncated: false, summary: 'not found', error: 'not found' }
  }
  if (res !== 'ok') {
    return { ok: false, output: `Could not click "${selector}".`, truncated: false, summary: 'error', error: 'click failed' }
  }
  return { ok: true, output: `Clicked "${selector}".`, truncated: false, summary: 'clicked' }
}

/**
 * Fill `selector` with `value`. Refuses password/credential fields outright — a
 * verification pass never types secrets (mirrors the browse executor).
 */
async function doFill(el: WebviewElement, selector: string, value: string): Promise<InspectReply> {
  if (SENSITIVE_FIELD_RE.test(selector)) {
    return {
      ok: false,
      output: 'Refused to fill a password/credential field — enter secrets yourself.',
      truncated: false,
      summary: 'refused (sensitive)',
      error: 'sensitive field'
    }
  }
  const sel = JSON.stringify(selector)
  const val = JSON.stringify(value)
  const res = (await el.executeJavaScript(`(function () {
    try {
      var el = document.querySelector(${sel});
      if (!el) return 'not-found';
      if (el.type === 'password' || el.type === 'hidden') return 'sensitive';
      el.focus();
      var proto = Object.getPrototypeOf(el);
      var setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${val}); else el.value = ${val};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    } catch (e) { return 'error'; }
  })()`)) as string
  if (res === 'sensitive') {
    return { ok: false, output: 'Refused to fill a password field.', truncated: false, summary: 'refused (sensitive)', error: 'sensitive field' }
  }
  if (res === 'not-found') {
    return { ok: false, output: `No field matched "${selector}".`, truncated: false, summary: 'not found', error: 'not found' }
  }
  if (res !== 'ok') {
    return { ok: false, output: `Could not fill "${selector}".`, truncated: false, summary: 'error', error: 'fill failed' }
  }
  return { ok: true, output: `Filled "${selector}".`, truncated: false, summary: 'filled' }
}

/**
 * Emulate a viewport by resizing the webview element. `desktop` clears the inline
 * size so the guest returns to the pane's natural size; presets and custom sizes
 * pin explicit pixels. A crude but honest stand-in for device emulation.
 */
function doResize(
  el: WebviewElement,
  preset: 'mobile' | 'tablet' | 'desktop' | undefined,
  width?: number,
  height?: number
): InspectReply {
  if (preset === 'desktop') {
    el.style.width = ''
    el.style.height = ''
    return { ok: true, output: 'Reset the preview to its natural (desktop) size.', truncated: false, summary: 'desktop' }
  }
  let w = width
  let h = height
  if (preset && preset in PRESET_SIZES) {
    w = PRESET_SIZES[preset as 'mobile' | 'tablet'].w
    h = PRESET_SIZES[preset as 'mobile' | 'tablet'].h
  }
  if (!w || !h) {
    return { ok: false, output: 'Resize needs a preset (mobile/tablet/desktop) or width+height.', truncated: false, summary: 'no size', error: 'missing size' }
  }
  el.style.width = `${w}px`
  el.style.height = `${h}px`
  return { ok: true, output: `Resized the preview to ${w}×${h}${preset ? ` (${preset})` : ''}.`, truncated: false, summary: `${w}×${h}` }
}

/**
 * Build the script `eval` actually runs in the guest.
 *
 * The value is formatted to text INSIDE the page on purpose: an arbitrary result
 * (a DOM node, a class instance, something cyclic) is not structured-cloneable, so
 * returning it raw would reject on the way back across the webview boundary and
 * the model would read an opaque serialization error instead of its answer. The
 * body is `await`ed, so a promise-returning expression resolves before formatting.
 */
function guestEvalSource(body: string): string {
  return `(async function () {
  function fmt(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return String(v);
    if (t === 'function') return 'function ' + (v.name || '(anonymous)') + '()';
    if (v instanceof Error) return String(v.stack || v.message || v);
    if (typeof Node !== 'undefined' && v instanceof Node) return String(v.outerHTML || v.textContent || v.nodeName);
    if (typeof v.length === 'number' && typeof v !== 'string' && !Array.isArray(v) && typeof v.item === 'function') {
      var parts = [];
      for (var i = 0; i < v.length && i < 40; i++) parts.push(fmt(v[i]));
      return '(' + v.length + ') [\\n' + parts.join('\\n') + (v.length > 40 ? '\\n…' : '') + '\\n]';
    }
    try {
      var seen = [];
      var json = JSON.stringify(v, function (k, val) {
        if (typeof val === 'function') return '[Function]';
        if (typeof val === 'bigint') return String(val);
        if (val && typeof val === 'object') {
          if (seen.indexOf(val) !== -1) return '[Circular]';
          seen.push(val);
          if (typeof Node !== 'undefined' && val instanceof Node) return '[' + val.nodeName + ']';
          if (typeof Window !== 'undefined' && val instanceof Window) return '[Window]';
        }
        return val;
      }, 2);
      return json === undefined ? String(v) : json;
    } catch (e) { return String(v); }
  }
  function cap(s) { return s.length > ${MAX_EVAL_CHARS} ? s.slice(0, ${MAX_EVAL_CHARS}) + '\\n…(truncated)' : s; }
  try {
    var __value = ${body};
    return { ok: true, text: cap(fmt(__value)) };
  } catch (e) {
    return { ok: false, text: cap(String((e && (e.stack || e.message)) || e)) };
  }
})()`
}

/** What one attempt at running guest code produced. */
type GuestEval = { kind: 'value'; ok: boolean; text: string } | { kind: 'threw'; message: string }

/** Run one wrapped body in the guest, normalising both failure paths. */
async function runGuestEval(el: WebviewElement, body: string): Promise<GuestEval> {
  try {
    const raw = (await el.executeJavaScript(guestEvalSource(body))) as {
      ok?: boolean
      text?: string
    } | null
    if (!raw || typeof raw.text !== 'string') {
      return { kind: 'threw', message: 'the guest page returned nothing' }
    }
    return { kind: 'value', ok: raw.ok === true, text: raw.text }
  } catch (e) {
    return { kind: 'threw', message: String((e as Error)?.message ?? e) }
  }
}

/**
 * Run `expression` in the guest page and report its value — the general-purpose
 * verification hatch (hover, key events, scrolling, reading app state, calling a
 * function the page exposes).
 *
 * Two shapes are accepted. An expression (`document.title`) is the common case; a
 * statement body (`const el = …; return el.offsetTop`) is only a *syntax* error in
 * the expression wrapper, so a SyntaxError retries as a function body rather than
 * being reported to the model as its own mistake. A statement body must `return`
 * its value — unlike a devtools console, a function body has no completion value.
 */
async function doEval(el: WebviewElement, expression: string): Promise<InspectReply> {
  // The closing paren goes on its own line so a trailing `// comment` in the
  // expression cannot swallow it.
  let res = await runGuestEval(el, `await (\n${expression}\n)`)
  if (res.kind === 'threw' && /syntax|unexpected/i.test(res.message)) {
    res = await runGuestEval(el, `await (async function () {\n${expression}\n})()`)
  }
  if (res.kind === 'threw') {
    return {
      ok: false,
      output: `Could not evaluate that in the preview: ${res.message}`,
      truncated: false,
      summary: 'error',
      error: res.message
    }
  }
  const { output, truncated } = clip(res.text)
  if (!res.ok) {
    return {
      ok: false,
      output: output || 'The expression threw.',
      truncated,
      summary: 'threw',
      error: res.text.split('\n')[0] || 'threw'
    }
  }
  const firstLine = res.text.split('\n')[0] ?? ''
  return {
    ok: true,
    output: output || '(no value)',
    truncated,
    summary: firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || 'evaluated'
  }
}

/**
 * Resolve a requested address to an absolute loopback URL, or say why not.
 *
 * `raw` may be absolute (`http://localhost:5173/about`) or relative to whatever the
 * preview currently holds (`/about`, `about.html`), which is what a model naturally
 * writes when walking the routes of the app it just built. Anything that is not
 * loopback http(s) is refused by NAME here rather than being silently dropped:
 * the preview pane is the user's own app, and the open web has its own gated tool.
 */
function resolveLoopback(raw: string, base: string): { url?: string; error?: string } {
  let parsed: URL
  try {
    parsed = new URL(raw, base || undefined)
  } catch {
    return {
      error: `"${raw}" is not an address the preview can load. Use an absolute http://localhost:PORT/… URL, or a path like /about once a page is loaded.`
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Refused to load "${raw}" — the preview only loads http(s) pages.` }
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return {
      error: `Refused to send the preview to ${parsed.hostname} — this pane shows the user's own app on localhost. Use the browse tool to visit the real web.`
    }
  }
  // 0.0.0.0 and ::1 are bind addresses a guest cannot reliably load: use loopback.
  if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::1') parsed.hostname = '127.0.0.1'
  return { url: parsed.href }
}

/**
 * Point the preview at another loopback page, or reload the current one when no
 * `url` is given (the refresh after a rebuild).
 *
 * Aiming goes through the store rather than `loadURL` on the element, so the
 * panel's address bar and the store's `previewUrl` stay truthful about what is
 * loaded — and the guest remount that follows is what {@link settle} waits for.
 */
async function doNavigate(rawUrl: string | undefined): Promise<InspectReply> {
  const current = useAppStore.getState().previewUrl ?? webview?.getURL() ?? ''
  const before = webview
  const reload = async (el: WebviewElement): Promise<InspectReply> => {
    el.reload()
    const live = await settle(null, RELOAD_GRACE_MS)
    const at = live?.getURL() || current
    return { ok: true, output: `Reloaded ${at}.`, truncated: false, summary: 'reloaded' }
  }
  if (!rawUrl) {
    if (!before) {
      return {
        ok: false,
        output: 'There is no preview page to reload yet — start the preview first.',
        truncated: false,
        summary: 'no preview',
        error: 'no webview'
      }
    }
    return reload(before)
  }
  const resolved = resolveLoopback(rawUrl, current)
  if (resolved.error || !resolved.url) {
    return {
      ok: false,
      output: resolved.error ?? 'Could not resolve that address.',
      truncated: false,
      summary: 'refused',
      error: 'not loopback'
    }
  }
  // Asking for the page already loaded reads as "refresh it" — and aiming the store
  // at an unchanged URL would remount nothing for settle() to wait for.
  if (resolved.url === current && before) return reload(before)
  useAppStore.getState().showLocalPreviewUrl(resolved.url)
  const live = await settle(before)
  if (!live) {
    return {
      ok: false,
      output: `The preview never loaded ${resolved.url}.`,
      truncated: false,
      summary: 'no preview',
      error: 'no webview'
    }
  }
  const at = live.getURL() || resolved.url
  const title = live.getTitle()
  const { output, truncated } = clip(`Navigated to ${at}.${title ? `\ntitle: ${title}` : ''}`)
  return { ok: true, output, truncated, summary: title || 'navigated' }
}

/** Turn a `data:` URL into the engine's media shape, or undefined if malformed. */
function toMedia(dataUrl: string): { kind: 'image'; mediaType: string; dataBase64: string } | undefined {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return undefined
  return { kind: 'image', mediaType: match[1], dataBase64: match[2] }
}

/** Route one request to its action handler. */
async function dispatch(req: PreviewInspectRequest): Promise<InspectReply> {
  // navigate runs before the guard below: aiming the pane is exactly what you do
  // when nothing is loaded yet, so it must not be refused for having no page.
  if (req.action === 'navigate') return doNavigate(req.url)
  const el = webview
  if (!el) {
    return { ok: false, output: 'The preview pane has no page loaded yet.', truncated: false, summary: 'no preview', error: 'no webview' }
  }
  switch (req.action) {
    case 'snapshot':
      return doSnapshot(el)
    case 'screenshot':
      return doScreenshot(el)
    case 'inspect':
      return doInspect(el, req.selector ?? '', req.styles)
    case 'console_logs':
      return doConsole(req.level)
    case 'network':
      return doNetwork(el, req.filter)
    case 'click':
      return doClick(el, req.selector ?? '')
    case 'fill':
      return doFill(el, req.selector ?? '', req.value ?? '')
    case 'resize':
      return doResize(el, req.preset, req.width, req.height)
    case 'eval':
      return doEval(el, req.expression ?? '')
    default:
      return { ok: false, output: `Unknown preview action.`, truncated: false, summary: 'unknown', error: 'unknown action' }
  }
}

/**
 * Subscribe to engine `preview_inspect` requests (idempotent — safe to call once
 * at app start). Each request is dispatched against the live webview and answered
 * over IPC. A handler that throws still replies with a failure so the engine's
 * awaiting promise never hangs.
 */
export function initPreviewInspector(): void {
  if (initialized) return
  initialized = true
  window.sylor?.preview?.onInspectRequest((req: PreviewInspectRequest) => {
    void dispatch(req)
      .catch((e): InspectReply => ({
        ok: false,
        output: String(e),
        truncated: false,
        summary: 'error',
        error: String(e)
      }))
      .then((reply) => {
        window.sylor?.preview?.respondInspect({ requestId: req.requestId, ...reply })
      })
  })
}


