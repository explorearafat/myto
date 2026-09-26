import { toErrorMessage } from '../providers/http'
import type { ToolContext, ToolDef, ToolGate } from './registry'
import { browserToolsEnabled } from '../cowork-browser'
import type { BrowserSession } from '../cowork-browser-cdp'

/**
 * The five `browser_*` tools (Track 2) — let Myto drive a browser (in Chat AND
 * Cowork) through the vision-free, ref-tagged text snapshot in ../cowork-browser +
 * ../cowork-browser-cdp, so a weak text-only BYOK model can navigate, read, click and
 * type without a vision model. Read-only tools (navigate/snapshot/read) never prompt;
 * click/type are `sideEffect:'exec'` so they are always confirmed before they act —
 * which matters most for the `system-chrome` target, where they touch the user's real
 * logins. In Chat, where there is no permission tier, those two are still approval-gated
 * (see the browser-exec gate in provider-ipc.ts).
 *
 * The live browser is obtained lazily per run via {@link ToolContext.getBrowser}
 * (built + disposed in provider-ipc.ts); these tools stay pure of Electron so they
 * are unit-testable with a fake session.
 */

/**
 * Available whenever a browser target other than `off` is armed (Settings › Cowork),
 * in BOTH Chat and Cowork — so "control the browser" works in the mode the user is
 * actually in, not only in Cowork. The mode-agnostic gate is deliberate: click/type
 * stay approval-gated in Chat via the permission gate in provider-ipc.ts.
 */
export function browserAvailable(gate: ToolGate): boolean {
  return browserToolsEnabled(gate.settings.cowork.browserTarget)
}

/** This run's memoized browser session, or a message explaining why there isn't one. */
async function getSession(ctx: ToolContext): Promise<BrowserSession | string> {
  if (!ctx.getBrowser) {
    return 'The browser is not available here — pick a browser in Settings › Cowork (off / in-app / system-chrome).'
  }
  try {
    return await ctx.getBrowser()
  } catch (err) {
    return `Could not start the browser: ${toErrorMessage(err)}`
  }
}

/** Read a string field off a tool input object. */
function readField(input: unknown, key: string): unknown {
  return input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
}

export const browserNavigateTool: ToolDef = {
  name: 'browser_navigate',
  description:
    'Open a URL in the browser and return a text outline of the page (a bare host becomes https://). Start here, then use browser_snapshot / browser_read to see the page and browser_click / browser_type to act.',
  usage: '{"url": "https://example.com"}',
  schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The page to open (http/https only).' } },
    required: ['url'],
    additionalProperties: false
  },
  available: browserAvailable,
  async run(input: unknown, ctx: ToolContext): Promise<string> {
    const s = await getSession(ctx)
    if (typeof s === 'string') return s
    return s.navigate(readField(input, 'url'))
  }
}
export const browserSnapshotTool: ToolDef = {
  name: 'browser_snapshot',
  description:
    'Return a compact text outline of the current page — every actionable element tagged with a [ref=eN] you pass to browser_click / browser_type. Take a fresh one after any navigation or click, since refs only apply to the latest snapshot.',
  usage: '{}',
  schema: { type: 'object', properties: {}, additionalProperties: false },
  available: browserAvailable,
  async run(_input: unknown, ctx: ToolContext): Promise<string> {
    const s = await getSession(ctx)
    if (typeof s === 'string') return s
    return s.snapshot()
  }
}

export const browserReadTool: ToolDef = {
  name: 'browser_read',
  description:
    "Return the current page's visible text — for reading an article, answer, or search results. Use browser_snapshot instead when you need refs to click or type.",
  usage: '{}',
  schema: { type: 'object', properties: {}, additionalProperties: false },
  available: browserAvailable,
  async run(_input: unknown, ctx: ToolContext): Promise<string> {
    const s = await getSession(ctx)
    if (typeof s === 'string') return s
    return s.readText()
  }
}
export const browserClickTool: ToolDef = {
  name: 'browser_click',
  description:
    'Click the element a [ref] from the latest browser_snapshot points at (a button, link, checkbox, menu item…). Take a fresh browser_snapshot afterwards to see what changed.',
  usage: '{"ref": "e3"}',
  sideEffect: 'exec',
  schema: {
    type: 'object',
    properties: { ref: { type: 'string', description: 'A ref like "e3" from the latest browser_snapshot.' } },
    required: ['ref'],
    additionalProperties: false
  },
  available: browserAvailable,
  async run(input: unknown, ctx: ToolContext): Promise<string> {
    const s = await getSession(ctx)
    if (typeof s === 'string') return s
    return s.click(input)
  }
}

export const browserTypeTool: ToolDef = {
  name: 'browser_type',
  description:
    'Type text into the field a [ref] from the latest browser_snapshot points at; add "submit": true to press Enter afterwards (e.g. to run a search). Take a fresh browser_snapshot to see the result.',
  usage: '{"ref": "e3", "text": "hello", "submit": true}',
  sideEffect: 'exec',
  schema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'A ref like "e3" from the latest browser_snapshot.' },
      text: { type: 'string', description: 'The text to type into the field.' },
      submit: { type: 'boolean', description: 'Press Enter after typing (default false).' }
    },
    required: ['ref'],
    additionalProperties: false
  },
  available: browserAvailable,
  async run(input: unknown, ctx: ToolContext): Promise<string> {
    const s = await getSession(ctx)
    if (typeof s === 'string') return s
    return s.type(input)
  }
}

/** The five browser tools, in the order the system prompt lists them (navigate → act). */
export const browserTools: readonly ToolDef[] = [
  browserNavigateTool,
  browserSnapshotTool,
  browserReadTool,
  browserClickTool,
  browserTypeTool
]
