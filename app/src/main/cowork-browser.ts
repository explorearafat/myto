/**
 * Track 2 (browser automation) foundation: turn a Chrome accessibility tree into a
 * compact, ref-tagged text outline a *text* model can read and act on — no
 * screenshots, no vision model. This is the piece that unblocks Track 2 for Cowork:
 * the reason it was deferred is that driving a browser usually needs a strong vision
 * model, but Cowork runs weak BYOK models; an accessibility/DOM snapshot sidesteps
 * that by handing the model the page as structured text with a stable `ref` per
 * actionable element. Pure and dependency-free so it is unit-testable in isolation
 * (same pattern as cowork-runtimes.ts / cowork-artifacts.ts); the Electron
 * BrowserView + CDP adapter that feeds it real AX nodes and acts on the refs lands
 * in a later increment.
 */

import type { BrowserTarget } from '../shared/types'

/** One node of Chrome's accessibility tree — the subset of CDP `Accessibility.AXNode` we use. */
export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  childIds?: string[]
  backendDOMNodeId?: number
}

/** What a `ref` in the outline resolves to — enough for a click/type tool to act on it. */
export interface ElementRef {
  ref: string
  role: string
  name: string
  backendDOMNodeId?: number
  nodeId: string
}

export interface PageSnapshot {
  /** The compact indented outline shown to the model. */
  outline: string
  /** ref (e.g. "e3") → the element it points at, for the click/type tools. */
  refs: Record<string, ElementRef>
}

/** Structural/wrapper roles that add no meaning — skipped, but their children are hoisted. */
const SKIP_ROLES = new Set([
  'none',
  'generic',
  'presentation',
  'GenericContainer',
  'InlineTextBox',
  'LineBreak'
])

/** Roles a user can act on — only these get a `[ref=…]` so click/type targets stay unambiguous. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'textfield'
])

/** Bound the snapshot so a huge page can't blow the model's context. */
const MAX_LINES = 200
const MAX_NAME = 120

/** Collapse whitespace and clip an accessible name/value to a bounded length. */
function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_NAME ? `${one.slice(0, MAX_NAME - 1)}…` : one
}

/**
 * Turn Chrome's flat accessibility-node list (CDP `Accessibility.getFullAXTree`) into
 * the compact indented outline the model reads, plus a `ref → element` map the click /
 * type tools resolve against. Structural wrapper nodes are dropped and their children
 * hoisted so `div` soup doesn't drown the real content; only actionable roles get a
 * `[ref=…]` so a click/type target is never ambiguous.
 */
export function buildPageSnapshot(nodes: AXNode[]): PageSnapshot {
  const byId = new Map<string, AXNode>()
  for (const n of nodes) if (n && n.nodeId) byId.set(n.nodeId, n)

  // A root is any node that nothing else lists as a child (CDP puts RootWebArea first).
  const childIds = new Set<string>()
  for (const n of nodes) for (const c of n.childIds ?? []) childIds.add(c)
  const roots = nodes.filter((n) => n.nodeId && !childIds.has(n.nodeId))

  const lines: string[] = []
  const refs: Record<string, ElementRef> = {}
  let refN = 0
  let truncated = false
  const seen = new Set<string>()

  const visit = (id: string, depth: number): void => {
    if (lines.length >= MAX_LINES) {
      truncated = true
      return
    }
    const node = byId.get(id)
    if (!node || seen.has(id)) return
    seen.add(id)

    const role = node.role?.value ?? ''
    const name = clip(node.name?.value ?? '')
    // Drop structural wrappers (and unnamed role-less nodes), but keep walking their
    // children at the SAME depth so the meaningful descendants still surface.
    if (node.ignored || SKIP_ROLES.has(role) || (!role && !name)) {
      for (const c of node.childIds ?? []) visit(c, depth)
      return
    }

    let line = `${'  '.repeat(depth)}- ${role || 'text'}`
    if (name) line += ` "${name}"`
    const value = clip(node.value?.value ?? '')
    if (value) line += ` = "${value}"`
    if (INTERACTIVE_ROLES.has(role)) {
      const ref = `e${++refN}`
      refs[ref] = { ref, role, name, backendDOMNodeId: node.backendDOMNodeId, nodeId: id }
      line += ` [ref=${ref}]`
    }
    lines.push(line)
    for (const c of node.childIds ?? []) visit(c, depth + 1)
  }

  for (const r of roots) visit(r.nodeId, 0)
  // Degenerate tree (every node is someone's child → a cycle): start from the first node.
  if (lines.length === 0 && nodes.length) visit(nodes[0].nodeId, 0)

  let outline = lines.join('\n')
  if (truncated) outline += `\n… (snapshot truncated at ${MAX_LINES} lines — scroll or narrow the view to see the rest)`
  if (!outline) outline = '(no visible, actionable content on the page)'
  return { outline, refs }
}

/**
 * Validate and normalize a `browser_navigate` target. A bare host becomes `https://…`;
 * only `http`/`https` are allowed so the model can't reach `file:`/`javascript:`/`data:`
 * URLs (local-file exfiltration, script injection) through the browser tool.
 */
export function normalizeNavigationUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'browser_navigate needs a JSON input like {"url": "https://example.com"}.' }
  }
  const trimmed = raw.trim()
  // No scheme → assume https (so "example.com" and "www.site.org/x" just work).
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { error: `Not a valid URL: "${raw}".` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Refused a ${parsed.protocol} URL — the browser tool only opens http and https pages.` }
  }
  return { url: parsed.toString() }
}

/**
 * Resolve a `{"ref": "e3"}` tool input against the latest snapshot's ref map. Returns
 * the target element, or a human-readable message telling the model what to do instead
 * (refs are only valid for the snapshot they came from — the page may have moved on).
 */
export function resolveRef(input: unknown, refs: Record<string, ElementRef>): ElementRef | string {
  const ref = input && typeof input === 'object' ? (input as Record<string, unknown>).ref : undefined
  if (typeof ref !== 'string' || !ref.trim()) {
    return 'This tool needs a {"ref": "e3"} taken from the most recent browser_snapshot.'
  }
  const el = refs[ref.trim()]
  if (!el) {
    return `Unknown ref "${ref}". Refs are only valid for the snapshot they came from — take a fresh browser_snapshot and use a ref from it.`
  }
  return el
}

/** The three user-selectable browser targets, in the order the settings UI lists them. */
export const BROWSER_TARGETS: readonly BrowserTarget[] = ['off', 'in-app', 'system-chrome']

/** Coalesce a possibly-undefined stored setting (older files) to the safe default. */
export function resolveBrowserTarget(target: BrowserTarget | undefined): BrowserTarget {
  return target && BROWSER_TARGETS.includes(target) ? target : 'off'
}

/** Are the browser tools active? False only when the target is `off`. */
export function browserToolsEnabled(target: BrowserTarget | undefined): boolean {
  return resolveBrowserTarget(target) !== 'off'
}

/** `system-chrome` drives the user's REAL logins, so it needs the extra safety consent. */
export function requiresRealChromeConsent(target: BrowserTarget | undefined): boolean {
  return resolveBrowserTarget(target) === 'system-chrome'
}

/** One-line human description of a target — reused by the settings UI and the system prompt. */
export function describeBrowserTarget(target: BrowserTarget | undefined): string {
  switch (resolveBrowserTarget(target)) {
    case 'in-app':
      return "Myto's own sandboxed browser (a blank profile — you log into sites inside Myto)."
    case 'system-chrome':
      return 'your real Chrome, reusing your existing logins (Gmail, WhatsApp, …) — higher-stakes, so clicks and typing ask first.'
    default:
      return 'off — the browser tools are hidden until you pick a browser in Settings › Cowork.'
  }
}

/**
 * Ordered list of paths a system Chrome/Chromium (or, as a Chromium-engine fallback,
 * Edge) usually lives at on `platform`, given the process environment. Pure — no disk
 * probing here; the `system-chrome` runtime adapter picks the first path that exists.
 * Same shape as cowork-runtimes' `runtimeCandidates` so it stays unit-testable.
 */
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {}
): string[] {
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files'
    const pfx86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = env['LOCALAPPDATA'] ?? ''
    const paths = [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx86}\\Microsoft\\Edge\\Application\\msedge.exe`
    ]
    return paths.filter((p): p is string => Boolean(p))
  }
  if (platform === 'darwin') {
    const home = env['HOME'] ?? ''
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      home && `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ].filter((p): p is string => Boolean(p))
  }
  // Linux and the rest.
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ]
}

/**
 * A plain desktop-Chrome User-Agent for the two Electron browser windows Myto opens
 * itself — the "Setup Myto Browser" window (cowork-browser-setup.ts) and the agent's
 * in-app browser (cowork-browser-runtime.ts).
 *
 * Electron's DEFAULT UA appends `Electron/<ver>` and the app-name token (`Myto/<ver>`)
 * after the Chrome token. UA-sniffing sites — WhatsApp Web, some Google/Microsoft login
 * pages — reject anything carrying those tokens with "unsupported browser / update
 * Google Chrome", even though the underlying Chromium is perfectly current. Presenting a
 * vanilla Chrome UA (no Electron/Myto tokens) makes those sites load and let the user log
 * in. The Chromium major here tracks Electron 43's engine so the version we claim is real.
 * (system-chrome drives the user's OWN Chrome, which already has a fine UA, so this is
 * only for the windows Myto creates.)
 */
export function chromeUserAgent(platform: NodeJS.Platform): string {
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36`
}
