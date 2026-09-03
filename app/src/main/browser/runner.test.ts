/**
 * The runner: the one entry point the engine's `browse` tool calls.
 *
 * Two things here are worth pinning down with tests, and they are the two the rest
 * of the agent loop depends on:
 *
 *  1. **Failure is a value, never a throw.** "No browser", "that element is gone",
 *     "that button spends money" all have to arrive as `output` text the model can
 *     recover from, because they become the next observation in the loop.
 *  2. **One step returns both what happened AND the page it landed on** — the
 *     settle-then-re-perceive pass is what stops the agent spending a turn asking
 *     "so what does the page look like now?".
 *
 * Everything runs against an injected fake {@link BrowserTarget} and an injected
 * `wait`, so there is no Electron, no page and no real time in this file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PerceptionSnapshot } from './perception'
import type { BrowserTarget } from './target'
import {
  browserDriver,
  classifyBrowse,
  CREDENTIAL_REFUSAL,
  describeBrowse,
  hostOf,
  MAX_LISTED,
  MAX_OUTPUT,
  PAYMENT_REFUSAL,
  renderSnapshot,
  runBrowserAction,
  setBrowserDriver,
  setBrowserTargets,
  settle
} from './runner'

/** Never wait for real time in a test. */
const instant = async (): Promise<void> => {}

/** What the in-page scan returns for a page with readable text and two controls. */
const SCAN = {
  url: 'https://example.com/inbox',
  title: 'Inbox',
  text: 'You have two new messages, and one of them needs a reply before Friday.',
  elements: [
    { idx: 1, tag: 'button', role: 'button', name: 'Compose', editable: false },
    { idx: 2, tag: 'a', role: 'link', name: 'Archive', editable: false }
  ]
}

interface Fake extends BrowserTarget {
  code: string
  loads: string[]
}

/**
 * A target with no Electron behind it. `guest` decides what the injected
 * expression "returns"; the default answers every scan with {@link SCAN}, which is
 * what makes the re-perception pass observable.
 */
function fake(over: Partial<Fake> & { guest?: (code: string) => unknown } = {}): Fake {
  const t: Fake = {
    code: '',
    loads: [],
    loadURL: async (url: string) => {
      t.loads.push(url)
    },
    getURL: () => SCAN.url,
    getTitle: () => SCAN.title,
    isLoading: () => false,
    executeJavaScript: async (code: string) => {
      t.code = code
      return over.guest ? over.guest(code) : SCAN
    },
    capturePage: async () => ({
      toDataURL: () => 'data:image/png;base64,QUJD',
      isEmpty: () => false
    }),
    ...over
  }
  return t
}

/** Wire `target` as the in-app driver, the way main does at startup. */
function wire(target: BrowserTarget | null, driver: 'app' | 'chrome' = 'app'): void {
  setBrowserTargets({ [driver]: () => target })
}

afterEach(() => {
  setBrowserTargets(null)
  setBrowserDriver('app')
})

describe('classifyBrowse', () => {
  it('maps each action onto the risk class the gate is keyed on', () => {
    expect(classifyBrowse({ action: 'read' })).toBe('read')
    expect(classifyBrowse({ action: 'scroll' })).toBe('read')
    expect(classifyBrowse({ action: 'navigate', url: 'x.com' })).toBe('navigate')
    expect(classifyBrowse({ action: 'type', target: 'Search' })).toBe('fill')
    expect(classifyBrowse({ action: 'click', target: 'Next' })).toBe('click')
  })

  it('reads a click through its label, so one action has four risk classes', () => {
    // This is the whole reason the gate is keyed on risk and not on the action: a
    // `click` is as safe or as final as the thing it is clicking.
    expect(classifyBrowse({ action: 'click', target: 'Send' })).toBe('send')
    expect(classifyBrowse({ action: 'click', target: 'Delete forever' })).toBe('delete')
    expect(classifyBrowse({ action: 'click', target: 'Place order' })).toBe('payment')
  })

  it('treats an unlabelled click as an ordinary click, not as unknown', () => {
    expect(classifyBrowse({ action: 'click' })).toBe('click')
  })
})

describe('describeBrowse', () => {
  it('phrases a step the way the card and status line show it', () => {
    expect(describeBrowse({ action: 'navigate', url: 'https://x.com' })).toBe('open https://x.com')
    expect(describeBrowse({ action: 'click', target: '12' })).toBe('click element #12')
    expect(describeBrowse({ action: 'click', target: 'Compose' })).toBe('click "Compose"')
    expect(describeBrowse({ action: 'type', target: 'Search' })).toBe('type into "Search"')
    expect(describeBrowse({ action: 'scroll', direction: 'up' })).toBe('scroll up')
    expect(describeBrowse({ action: 'scroll' })).toBe('scroll down')
    expect(describeBrowse({ action: 'read' })).toBe('read the page')
  })

  it('still says something when the model left the target out', () => {
    expect(describeBrowse({ action: 'click' })).toBe('click an element')
    expect(describeBrowse({ action: 'type' })).toBe('type into a field')
    expect(describeBrowse({ action: 'navigate' })).toBe('open (url)')
  })
})

describe('hostOf', () => {
  it('strips the scheme, the path and a leading www', () => {
    expect(hostOf('https://www.example.com/a/b?c=1')).toBe('example.com')
    expect(hostOf('http://mail.google.com')).toBe('mail.google.com')
  })

  it('is empty rather than wrong for a non-url', () => {
    expect(hostOf('about:blank')).toBe('')
    expect(hostOf('')).toBe('')
  })
})

describe('renderSnapshot', () => {
  const snap = (over: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot => ({
    mode: 'dom',
    url: SCAN.url,
    title: SCAN.title,
    text: SCAN.text,
    elements: SCAN.elements,
    ...over
  })

  it('leads with the page identity, then text, then numbered controls', () => {
    const { text, truncated } = renderSnapshot(snap())
    expect(text).toContain(`PAGE mode=dom title=Inbox url=${SCAN.url}`)
    expect(text).toContain('VISIBLE TEXT:')
    expect(text).toContain(SCAN.text)
    // The number IS the address the model passes back as `target`.
    expect(text).toContain('INTERACTIVE ELEMENTS (use the number as `target`)')
    expect(text).toContain('[1] button "Compose"')
    expect(text).toContain('[2] link "Archive"')
    expect(truncated).toBe(false)
  })

  it('labels an editable element by its input type, and marks a dead control', () => {
    const { text } = renderSnapshot(
      snap({
        elements: [
          { idx: 1, tag: 'input', role: 'textbox', name: 'Search', editable: true, type: 'search' },
          { idx: 2, tag: 'button', role: 'button', name: 'Send', editable: false, disabled: true }
        ]
      })
    )
    expect(text).toContain('[1] input:search "Search"')
    expect(text).toContain('[2] button "Send" (disabled)')
  })

  it('says "(none)" instead of going blank on an empty page', () => {
    const { text } = renderSnapshot(snap({ text: '', elements: [] }))
    expect(text).toContain('VISIBLE TEXT:\n(none)')
    expect(text).toContain('target`):\n(none)')
  })

  it('caps the page text and reports that it clipped', () => {
    const { text, truncated } = renderSnapshot(snap({ text: 'x'.repeat(MAX_OUTPUT + 500) }))
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThan(MAX_OUTPUT + 600)
  })

  it('caps the element list, because the rest is one scroll away', () => {
    const many = Array.from({ length: MAX_LISTED + 10 }, (_, i) => ({
      idx: i,
      tag: 'a',
      role: 'link',
      name: `Item ${i}`,
      editable: false
    }))
    const { text, truncated } = renderSnapshot(snap({ elements: many }))
    expect(truncated).toBe(true)
    expect(text).toContain(`[${MAX_LISTED - 1}] link`)
    expect(text).not.toContain(`[${MAX_LISTED}] link`)
  })

  it('carries a snapshot that was already clipped in the page', () => {
    expect(renderSnapshot(snap({ truncated: true })).truncated).toBe(true)
  })

  it('tells the model plainly when all it has is a picture', () => {
    // A vision snapshot has no DOM to list; the screenshot rides the vision path.
    const { text } = renderSnapshot(snap({ mode: 'vision', text: '', elements: [] }))
    expect(text).toContain('mode=vision')
    expect(text).toContain('a screenshot is attached instead')
    expect(text).not.toContain('INTERACTIVE ELEMENTS')
  })
})

describe('settle', () => {
  it('returns once the page has been idle twice, not on the first sample', async () => {
    // One idle sample would read the page it is about to leave — which is exactly
    // what makes an agent re-issue a step and look stuck.
    let calls = 0
    const target = fake({
      isLoading: () => {
        calls += 1
        return calls <= 2
      }
    })
    await settle(target, true, instant)
    expect(calls).toBeGreaterThanOrEqual(4)
  })

  it('gives up quietly if the target stops answering', async () => {
    const target = fake({
      isLoading: () => {
        throw new Error('destroyed')
      }
    })
    await expect(settle(target, false, instant)).resolves.toBeUndefined()
  })
})

describe('runBrowserAction — no browser', () => {
  it('explains that there is nothing to drive in app mode', async () => {
    setBrowserTargets(null)
    const out = await runBrowserAction({ action: 'read' }, { wait: instant })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('no browser')
    expect(out.error).toContain('no page to drive')
  })

  it('tells the model how to get a real browser in chrome mode', async () => {
    // The recovery instruction matters: this text is the model's next observation.
    setBrowserDriver('chrome')
    setBrowserTargets({ chrome: () => null })
    const out = await runBrowserAction({ action: 'read' }, { wait: instant })
    expect(out.error).toContain('My Chrome')
  })

  it('survives a target factory that throws', async () => {
    setBrowserTargets({
      app: () => {
        throw new Error('window is gone')
      }
    })
    const out = await runBrowserAction({ action: 'read' }, { wait: instant })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('no browser')
  })
})

describe('runBrowserAction — the two refusals no policy can switch off', () => {
  it('refuses a payment-shaped click before it touches the page', async () => {
    const target = fake()
    const spy = vi.spyOn(target, 'executeJavaScript')
    wire(target)
    const out = await runBrowserAction(
      { action: 'click', target: 'Place order' },
      { wait: instant }
    )
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('payment refused')
    expect(out.output).toBe(PAYMENT_REFUSAL)
    // Not clicked-then-regretted: the page was never asked.
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses to type into a credential-looking field', async () => {
    wire(fake())
    const out = await runBrowserAction(
      { action: 'type', target: 'Password', text: 'hunter2' },
      { wait: instant }
    )
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('credentials refused')
    expect(out.output).toBe(CREDENTIAL_REFUSAL)
  })

  it('still refuses when the field name only hints at a secret', async () => {
    wire(fake())
    for (const field of ['Card number', 'CVV', 'One-time PIN', 'API token']) {
      const out = await runBrowserAction({ action: 'type', target: field, text: 'x' }, { wait: instant })
      expect(out.summary).toBe('credentials refused')
    }
  })
})

describe('runBrowserAction — a step returns what happened AND the page', () => {
  it('reads the page without acting on it', async () => {
    wire(fake())
    const out = await runBrowserAction({ action: 'read' }, { wait: instant })
    expect(out.ok).toBe(true)
    expect(out.action).toBe('read')
    expect(out.summary).toBe('read example.com')
    expect(out.url).toBe(SCAN.url)
    expect(out.output).toContain(SCAN.text)
    expect(out.output).toContain('[1] button "Compose"')
  })

  it('navigates, then re-perceives, so one step lands and reports', async () => {
    const target = fake()
    wire(target)
    const out = await runBrowserAction(
      { action: 'navigate', url: 'example.com/inbox' },
      { wait: instant }
    )
    expect(target.loads).toEqual(['https://example.com/inbox'])
    expect(out.summary).toBe('opened example.com')
    // Both halves are in the one output: the act, then the page it produced.
    expect(out.output).toContain('Loaded https://example.com/inbox')
    expect(out.output).toContain('VISIBLE TEXT:')
  })

  it('clicks by the number the last read handed out', async () => {
    // `el.click()` is the discriminator, not the idx attribute: the perception scan
    // tags elements with `data-sylor-idx` too, so matching on that would answer the
    // re-perception pass with the click's own boolean.
    const target = fake({ guest: (code) => (code.includes('el.click()') ? true : SCAN) })
    wire(target)
    const out = await runBrowserAction({ action: 'click', target: '1' }, { wait: instant })
    expect(out.ok).toBe(true)
    expect(out.summary).toBe('clicked 1')
    expect(out.output).toContain('Clicked element #1.')
  })

  it('reports a missed element as a recoverable failure with the live url', async () => {
    const target = fake({ guest: (code) => (code.includes('el.click()') ? false : SCAN) })
    wire(target)
    const out = await runBrowserAction({ action: 'click', target: 'Ghost' }, { wait: instant })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('click failed')
    expect(out.error).toContain('is not on the page')
    expect(out.url).toBe(SCAN.url)
  })

  it('asks for a target instead of guessing one', async () => {
    wire(fake())
    const out = await runBrowserAction({ action: 'click' }, { wait: instant })
    expect(out.summary).toBe('no target')
    expect(out.error).toContain('the number from the last read')
  })

  it('scrolls and says so', async () => {
    const target = fake({ guest: (code) => (code.includes('scrollBy') ? 700 : SCAN) })
    wire(target)
    const out = await runBrowserAction({ action: 'scroll', direction: 'down' }, { wait: instant })
    expect(out.summary).toBe('scrolled down')
    expect(out.output).toContain('Scrolled down (700px).')
  })

  it('hands a visual read to the vision path as image bytes', async () => {
    // `visual` skips the DOM ladder outright — the point is pixels, so a page with
    // perfectly good text still comes back as a screenshot.
    wire(fake())
    const out = await runBrowserAction({ action: 'read', visual: true }, { wait: instant })
    expect(out.ok).toBe(true)
    expect(out.media).toEqual({ kind: 'image', mediaType: 'image/png', dataBase64: 'QUJD' })
    expect(out.output).toContain('mode=vision')
  })

  it('carries no media when the capture came back empty', async () => {
    wire(
      fake({
        capturePage: async () => ({ toDataURL: () => '', isEmpty: () => true })
      })
    )
    const out = await runBrowserAction({ action: 'read', visual: true }, { wait: instant })
    expect(out.media).toBeUndefined()
  })

  it('falls back to a screenshot when the page has no readable DOM', async () => {
    // An honest fallback, never the default: a canvas app or a cross-origin frame
    // yields nothing to read, and a blank text dump would be a lie.
    wire(fake({ guest: () => null }))
    const out = await runBrowserAction({ action: 'read' }, { wait: instant })
    expect(out.ok).toBe(true)
    expect(out.output).toContain('mode=vision')
    expect(out.media?.dataBase64).toBe('QUJD')
  })
})

describe('driver selection', () => {
  it('defaults to the in-app page view', () => {
    expect(browserDriver()).toBe('app')
  })

  it('follows the panel switch, and coerces anything unexpected to app', () => {
    setBrowserDriver('chrome')
    expect(browserDriver()).toBe('chrome')
    setBrowserDriver('nonsense' as 'app')
    expect(browserDriver()).toBe('app')
  })

  it('lets one step override the active driver', async () => {
    // The engine can pin a step to a driver without disturbing the user's choice.
    const app = fake()
    const chrome = fake({ getURL: () => 'https://mail.google.com/mail/u/0' })
    setBrowserTargets({ app: () => app, chrome: () => chrome })
    setBrowserDriver('app')
    const out = await runBrowserAction({ action: 'read', driver: 'chrome' }, { wait: instant })
    expect(out.url).toBe(SCAN.url)
    expect(chrome.code).not.toBe('')
    expect(app.code).toBe('')
    expect(browserDriver()).toBe('app')
  })
})
