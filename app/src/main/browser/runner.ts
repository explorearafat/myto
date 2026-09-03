/**
 * The one entry point the engine's `browse` tool calls.
 *
 * Everything above this line is the agent loop; everything below it is a
 * {@link BrowserTarget}. The runner picks the target for the active driver, performs
 * the action, waits for the page to settle, and reads the result back as a compact
 * page brief — so a single `browse` step gives the model both *what happened* and
 * *what the page looks like now*, instead of costing two turns.
 *
 * The targets are injected ({@link setBrowserTargets}) exactly as
 * `preview/inspect.ts` injects its transport: main wires the real
 * `WebContentsView` and real-Chrome adapters at startup, and a test passes a fake
 * target, so the whole module runs with no Electron and no browser.
 *
 * No permission decision is made here. The engine's gate (`workflow/permission.ts`)
 * has already run by the time the runner is called; the only refusals in this file
 * are the two that are never negotiable — a payment-classified click and typing into
 * a credential field.
 */
import type { BrowseAction, BrowserAction } from '@shared/types'
import {
  classifyClick,
  click,
  navigate,
  parseRef,
  scroll,
  SENSITIVE_FIELD_RE,
  type ActionOutcome,
  describeRef,
  type ElementRef,
  type as typeInto
} from './actions'
import { inspectElement, installRecorder, readConsole, readNetwork } from './debug'
import { perceivePage, type PerceptionSnapshot } from './perception'
import type { BrowserDriver, BrowserTarget } from './target'

/** One `browse` step, as the engine hands it over. */
export interface BrowsePayload {
  action: BrowseAction
  /** Which browser to drive. Defaults to whatever the panel last selected. */
  driver?: BrowserDriver
  url?: string
  target?: string
  text?: string
  submit?: boolean
  direction?: 'up' | 'down'
  visual?: boolean
  /** `inspect` — the element to report on. */
  selector?: string
  /** `inspect` — extra computed CSS properties. */
  styles?: string[]
  /** `console` — which messages to keep. */
  level?: 'all' | 'error' | 'warn'
  /** `network` — which requests to keep. */
  filter?: 'all' | 'failed'
}

/** What the engine turns into a `BrowseResult`. */
export interface BrowseOutcome {
  ok: boolean
  action: BrowseAction
  output: string
  truncated: boolean
  summary: string
  url?: string
  media?: { kind: 'image'; mediaType: string; dataBase64: string }
  error?: string
}

/** How much page text one step may put in front of the model. */
export const MAX_OUTPUT = 8000
/** How many interactive elements to list (the rest are reachable after a scroll). */
export const MAX_LISTED = 60

// ---------------------------------------------------------------------------
// Wiring — injected so this module is Electron-free
// ---------------------------------------------------------------------------

/** How the runner obtains a target for each driver. Null means "not available here". */
export interface BrowserTargetFactories {
  app?: () => BrowserTarget | null
  chrome?: () => BrowserTarget | null
}

let factories: BrowserTargetFactories = {}
let activeDriver: BrowserDriver = 'app'

/** Wire the real targets (main), or fakes (tests). Passing null unwires everything. */
export function setBrowserTargets(next: BrowserTargetFactories | null): void {
  factories = next ?? {}
}

/** Which browser the next `browse` drives. Set by the panel's driver control. */
export function setBrowserDriver(next: BrowserDriver): void {
  activeDriver = next === 'chrome' ? 'chrome' : 'app'
}

export function browserDriver(): BrowserDriver {
  return activeDriver
}

/** Resolve a target, or null when that driver has nothing to drive. */
function targetFor(driver: BrowserDriver): BrowserTarget | null {
  try {
    return factories[driver]?.() ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Settling — so the NEXT read sees the page the action produced
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Wait (bounded) for the page to stop loading.
 *
 * `isLoading()` is a host-side read, so polling it is free and can be tight. Two
 * consecutive idle samples, not one: a click that kicks off a fetch or a redirect
 * needs a beat before `isLoading()` flips true, and stopping at the first idle
 * sample would read the page it was about to leave — which is exactly what makes an
 * agent re-issue the same step and look like it is stuck.
 */
export async function settle(
  target: BrowserTarget,
  navigating: boolean,
  wait: (ms: number) => Promise<void> = sleep
): Promise<void> {
  const cap = navigating ? 3500 : 900
  await wait(navigating ? 120 : 60)
  const deadline = Date.now() + cap
  let quiet = 0
  while (Date.now() < deadline) {
    let busy: boolean
    try {
      busy = target.isLoading()
    } catch {
      return
    }
    if (!busy) {
      if (++quiet >= 2) return
    } else {
      quiet = 0
    }
    await wait(50)
  }
}

// ---------------------------------------------------------------------------
// Rendering a snapshot for the model
// ---------------------------------------------------------------------------

/** Turn a perception snapshot into the compact PAGE brief the model reads. */
export function renderSnapshot(snap: PerceptionSnapshot): { text: string; truncated: boolean } {
  const head = `PAGE mode=${snap.mode} title=${snap.title || '(untitled)'} url=${snap.url}`
  if (snap.mode === 'vision') {
    return {
      text: `${head}\n(no readable DOM on this page — a screenshot is attached instead)`,
      truncated: false
    }
  }
  let truncated = !!snap.truncated
  let text = snap.text || ''
  if (text.length > MAX_OUTPUT) {
    text = text.slice(0, MAX_OUTPUT)
    truncated = true
  }
  const shown = snap.elements.slice(0, MAX_LISTED)
  if (shown.length < snap.elements.length) truncated = true
  const elements = shown
    .map((e) => {
      const kind = e.editable ? `input:${e.type || 'text'}` : e.role
      return `[${e.idx}] ${kind} "${e.name}"${e.disabled ? ' (disabled)' : ''}`
    })
    .join('\n')
  return {
    text:
      `${head}\n\nVISIBLE TEXT:\n${text || '(none)'}\n\n` +
      `INTERACTIVE ELEMENTS (use the number as \`target\`):\n${elements || '(none)'}`,
    truncated
  }
}

/** Split a `data:image/png;base64,…` url into the media shape results carry. */
function mediaOf(dataUrl: string | undefined): BrowseOutcome['media'] {
  if (!dataUrl || !dataUrl.startsWith('data:')) return undefined
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return undefined
  const mediaType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png'
  const dataBase64 = dataUrl.slice(comma + 1)
  return dataBase64 ? { kind: 'image', mediaType, dataBase64 } : undefined
}

/** A failure the model can act on, rather than an exception. */
function failed(action: BrowseAction, detail: string, summary = 'browse failed'): BrowseOutcome {
  return { ok: false, action, output: detail, truncated: false, summary, error: detail }
}

/** The refusal text for a click that reads like it spends money. */
export const PAYMENT_REFUSAL =
  'Refused: that control looks like it completes a payment or purchase. Sylor never ' +
  'spends money on your behalf — do this step yourself and tell me when to carry on.'

/** The refusal text for typing into a credential-looking field. */
export const CREDENTIAL_REFUSAL =
  'Refused: that field looks like a password, card number or other secret. Sylor never ' +
  'types credentials — please enter it yourself, then tell me to continue.'

/**
 * Classify one step for the permission gate, before it runs.
 *
 * Exported because the engine needs the same answer *before* dispatching (to decide
 * whether to ask the user), and the runner needs it again to enforce the two
 * refusals that no policy can turn off.
 */
export function classifyBrowse(payload: BrowsePayload): BrowserAction {
  switch (payload.action) {
    case 'navigate':
      return 'navigate'
    case 'click':
      return classifyClick(payload.target ?? '')
    case 'type':
      return 'fill'
    default:
      return 'read'
  }
}

/** A short human phrase for the card and the status line. */
export function describeBrowse(payload: BrowsePayload): string {
  const ref = payload.target ? describeRef(parseRef(payload.target) ?? { kind: 'label', label: payload.target }) : ''
  switch (payload.action) {
    case 'navigate':
      return `open ${payload.url || '(url)'}`
    case 'click':
      return `click ${ref || 'an element'}`
    case 'type':
      return `type into ${ref || 'a field'}`
    case 'scroll':
      return `scroll ${payload.direction === 'up' ? 'up' : 'down'}`
    case 'console':
      return payload.level && payload.level !== 'all'
        ? `read the console (${payload.level})`
        : 'read the console'
    case 'network':
      return payload.filter === 'failed' ? 'read the failed requests' : 'read the network'
    case 'inspect':
      return `inspect ${payload.selector || 'an element'}`
    default:
      return 'read the page'
  }
}

/**
 * Perform one browse step and read the resulting page back.
 *
 * Failure is always a value, never a throw: the agent loop turns the `output` into
 * the next observation, so "no browser available" or "that element is gone" has to
 * arrive as text it can recover from.
 */
export async function runBrowserAction(
  payload: BrowsePayload,
  opts: { wait?: (ms: number) => Promise<void> } = {}
): Promise<BrowseOutcome> {
  const action = payload.action
  const driver = payload.driver ?? activeDriver
  const target = targetFor(driver)
  if (!target) {
    return failed(
      action,
      driver === 'chrome'
        ? 'No real browser is available to drive. Ask the user to press "My Chrome" in the browser panel, or use the in-app browser instead.'
        : 'The browser panel is not available right now, so there is no page to drive.',
      'no browser'
    )
  }

  // The two refusals no setting can switch off.
  if (action === 'click' && classifyClick(payload.target ?? '') === 'payment') {
    return failed(action, PAYMENT_REFUSAL, 'payment refused')
  }
  if (action === 'type' && SENSITIVE_FIELD_RE.test(payload.target ?? '')) {
    return failed(action, CREDENTIAL_REFUSAL, 'credentials refused')
  }

  // The debugging reads answer on their own. They deliberately do NOT append a page
  // brief: asking for the console and getting the whole DOM back would drown the
  // thing that was asked about, and the page has not changed anyway.
  if (action === 'console' || action === 'network' || action === 'inspect') {
    return await runDebugRead(target, payload, action)
  }

  // Start recording this page's console + requests BEFORE acting, so the errors an
  // action provokes are there to be read afterwards. Idempotent, and a page that
  // refuses the injection simply has nothing buffered — never a failed step.
  await installRecorder(target)

  let outcome: ActionOutcome
  let ref: ElementRef | null = null
  switch (action) {
    case 'read':
      outcome = { ok: true, detail: '' }
      break
    case 'navigate':
      outcome = await navigate(target, payload.url ?? '')
      break
    case 'click':
    case 'type':
      ref = parseRef(payload.target ?? '')
      if (!ref) {
        return failed(
          action,
          `No element was given to ${action}. Pass \`target\` as the number from the last read, or the control's visible text.`,
          'no target'
        )
      }
      outcome =
        action === 'click'
          ? await click(target, ref)
          : await typeInto(target, ref, payload.text ?? '', payload.submit === true)
      break
    case 'scroll':
      outcome = await scroll(target, payload.direction === 'up' ? 'up' : 'down')
      break
    default:
      return failed(action, `Unknown browse action "${String(action)}".`, 'unknown action')
  }

  if (!outcome.ok) {
    const summary = outcome.reason === 'refused' ? 'refused' : `${action} failed`
    return { ...failed(action, outcome.detail, summary), url: safe(() => target.getURL()) }
  }

  // Let the page catch up, then read it back so the model sees what its own action
  // produced without spending another step on it.
  if (action !== 'read') await settle(target, action === 'navigate', opts.wait)
  // A navigation swapped the document out, and the recorder went with it.
  if (action === 'navigate') await installRecorder(target)

  const snapshot = await perceivePage(target, { preferVision: payload.visual === true })
  const rendered = renderSnapshot(snapshot)
  const media = mediaOf(snapshot.imageDataUrl)
  const lead = outcome.detail ? `${outcome.detail}\n\n` : ''
  return {
    ok: true,
    action,
    output: `${lead}${rendered.text}`,
    truncated: rendered.truncated,
    summary: summarize(action, payload, snapshot),
    url: snapshot.url || safe(() => target.getURL()),
    ...(media ? { media } : {})
  }
}

/** Never let a getter throw out of a result path. */
function safe(read: () => string): string {
  try {
    return read()
  } catch {
    return ''
  }
}

/**
 * The three debugging reads (`console`, `network`, `inspect`).
 *
 * Each answers with its own report and nothing else — no settle, no perception pass.
 * A debug read changes nothing about the page, so re-reading the DOM would only bury
 * the answer under a page brief the model already has from the step before.
 */
async function runDebugRead(
  target: BrowserTarget,
  payload: BrowsePayload,
  action: 'console' | 'network' | 'inspect'
): Promise<BrowseOutcome> {
  const url = safe(() => target.getURL())
  if (action === 'inspect') {
    const selector = (payload.selector ?? payload.target ?? '').trim()
    if (!selector) {
      return failed(
        action,
        'No element was given to inspect. Pass `selector` as a CSS selector (e.g. ".hero h1").',
        'no selector'
      )
    }
    const report = await inspectElement(target, selector, payload.styles ?? [])
    return {
      ok: true,
      action,
      output: report.text,
      truncated: report.truncated,
      summary: `inspected ${selector}`,
      url
    }
  }
  const report =
    action === 'console'
      ? await readConsole(target, payload.level ?? 'all')
      : await readNetwork(target, payload.filter ?? 'all')
  const scope = action === 'console' ? 'message' : 'request'
  return {
    ok: true,
    action,
    output: report.text,
    truncated: report.truncated,
    summary: report.count
      ? `read ${report.count} ${scope}${report.count === 1 ? '' : 's'}`
      : `read the ${action} (nothing recorded)`,
    url
  }
}

/** The one-line label the tool card shows. */
function summarize(
  action: BrowseAction,
  payload: BrowsePayload,
  snapshot: PerceptionSnapshot
): string {
  const host = hostOf(snapshot.url)
  switch (action) {
    case 'navigate':
      return `opened ${host || payload.url || 'a page'}`
    case 'click':
      return `clicked ${payload.target ?? 'an element'}`
    case 'type':
      return `typed into ${payload.target ?? 'a field'}`
    case 'scroll':
      return `scrolled ${payload.direction === 'up' ? 'up' : 'down'}`
    default:
      return `read ${host || 'the page'}`
  }
}

/** Host part of a url, for a compact card label. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url || '')
  return m ? m[1].replace(/^www\./i, '') : ''
}
