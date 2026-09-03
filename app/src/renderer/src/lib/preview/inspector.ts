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
 * The eight actions mirror the CC preview_* tools:
 *   - `snapshot`     — accessibility/DOM listing (text + interactive elements).
 *   - `screenshot`   — a PNG of the rendered page (handed to the vision model).
 *   - `inspect`      — computed styles + box of one element (verify colors/size).
 *   - `console_logs` — recent guest console output (spot runtime errors).
 *   - `network`      — resource-timing entries (spot failed/slow requests).
 *   - `click`/`fill` — drive an interaction, then the engine re-snapshots.
 *   - `resize`       — emulate a mobile/tablet/custom viewport.
 *
 * SECURITY: like the browse executor, `fill` refuses password/credential
 * fields outright — verification never types secrets. Everything here observes or
 * drives the user's OWN local preview; nothing reaches the network or disk.
 */
import type { WebviewElement } from '@renderer/types/webview'
import type { PreviewInspectRequest, PreviewInspectResponse } from '@shared/types'
import { perceivePage } from './perception'

/** A reply minus the correlation id (the IPC handler re-attaches `requestId`). */
type InspectReply = Omit<PreviewInspectResponse, 'requestId'>

/** Caps that keep a reply context-safe (never dump an unbounded page). */
const MAX_OUTPUT = 8_000
const MAX_CONSOLE = 200
const MAX_NETWORK = 120

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

/** PLACEHOLDER_BODY */

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

/** Turn a `data:` URL into the engine's media shape, or undefined if malformed. */
function toMedia(dataUrl: string): { kind: 'image'; mediaType: string; dataBase64: string } | undefined {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return undefined
  return { kind: 'image', mediaType: match[1], dataBase64: match[2] }
}

/** Route one request to its action handler. */
async function dispatch(req: PreviewInspectRequest): Promise<InspectReply> {
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


