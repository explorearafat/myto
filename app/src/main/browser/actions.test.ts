/**
 * The action layer: how a `browse` step is classified, addressed and performed.
 *
 * All four action bodies are pure functions over a {@link BrowserTarget}, so this
 * whole file runs with no Electron and no page — the fake target records the
 * expression it was handed and answers with whatever the test wants the guest to
 * have returned. What is worth pinning here is the part a real page cannot be
 * trusted to prove: that a payment-shaped label escalates, that a password field
 * is refused, and that a failed find comes back as a value instead of a throw.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserTarget } from './target'
import {
  classifyClick,
  click,
  DELETE_RE,
  navigate,
  normalizeUrl,
  parseRef,
  PAYMENT_RE,
  scroll,
  SENSITIVE_FIELD_RE,
  SEND_RE,
  describeRef,
  type as typeInto
} from './actions'

/** A target whose guest returns `reply` (or throws it, if it is an Error). */
function fake(reply: unknown, url = 'https://example.com'): BrowserTarget & { code: string } {
  const t = {
    code: '',
    loadURL: vi.fn(async () => {}),
    getURL: () => url,
    getTitle: () => 'Fake',
    isLoading: () => false,
    executeJavaScript: async (code: string) => {
      t.code = code
      if (reply instanceof Error) throw reply
      return reply
    },
    capturePage: async () => ({ toDataURL: () => '', isEmpty: () => true })
  }
  return t
}

describe('classifyClick', () => {
  it.each([
    ['Pay now', 'payment'],
    ['Buy it again', 'payment'],
    ['Place order', 'payment'],
    ['Subscribe', 'payment'],
    ['Delete account', 'delete'],
    ['Move to trash', 'delete'],
    ['Send', 'send'],
    ['Post reply', 'send'],
    ['Submit', 'send'],
    ['Next page', 'click'],
    ['Compose', 'click']
  ] as const)('%s → %s', (label, expected) => {
    expect(classifyClick(label)).toBe(expected)
  })

  it('escalates to the strongest class when a label matches more than one', () => {
    // "Confirm purchase and send receipt" is a payment first and foremost — the
    // order of the checks is the safety property, not an implementation detail.
    expect(classifyClick('Confirm purchase and send receipt')).toBe('payment')
    expect(classifyClick('Delete and post an update')).toBe('delete')
  })

  it('matches on whole words, so ordinary UI text is not mistaken for a payment', () => {
    // A regex without word boundaries would read "Company" as "pay" and refuse to
    // click a nav link.
    expect(PAYMENT_RE.test('Company')).toBe(false)
    expect(SEND_RE.test('Sender name')).toBe(false)
    expect(DELETE_RE.test('Removal policy')).toBe(false)
    expect(classifyClick('Payment history')).toBe('click')
  })

  it('treats an unlabelled element as an ordinary click', () => {
    expect(classifyClick('')).toBe('click')
  })
})

describe('normalizeUrl', () => {
  it.each([
    ['https://example.com/x', 'https://example.com/x'],
    ['HTTP://example.com', 'HTTP://example.com'],
    ['example.com', 'https://example.com'],
    ['news.ycombinator.com/news', 'https://news.ycombinator.com/news'],
    ['localhost:5173', 'https://duckduckgo.com/?q=localhost%3A5173']
  ])('%s → %s', (raw, expected) => {
    expect(normalizeUrl(raw)).toBe(expected)
  })

  it('searches for anything that is not a host, instead of failing the step', () => {
    // The model will pass a phrase, and a dead step costs a whole turn.
    expect(normalizeUrl('best electron ipc pattern')).toBe(
      'https://duckduckgo.com/?q=best%20electron%20ipc%20pattern'
    )
  })

  it('returns empty for empty input, so the caller can report "no URL"', () => {
    expect(normalizeUrl('   ')).toBe('')
  })
})

describe('parseRef', () => {
  it('reads a perceived index, with or without the #', () => {
    expect(parseRef('12')).toEqual({ kind: 'index', idx: 12 })
    expect(parseRef('#12')).toEqual({ kind: 'index', idx: 12 })
  })

  it('falls back to a label, because the model names buttons', () => {
    expect(parseRef('Compose')).toEqual({ kind: 'label', label: 'Compose' })
    // A label that merely contains digits is still a label.
    expect(parseRef('Page 2')).toEqual({ kind: 'label', label: 'Page 2' })
  })

  it('is null for nothing at all', () => {
    expect(parseRef('')).toBeNull()
    expect(parseRef('  ')).toBeNull()
  })

  it('describes both kinds for cards and refusals', () => {
    expect(describeRef({ kind: 'index', idx: 3 })).toBe('element #3')
    expect(describeRef({ kind: 'label', label: 'Send' })).toBe('"Send"')
  })
})

describe('navigate', () => {
  it('normalizes before loading and reports where it went', async () => {
    const target = fake(null)
    const out = await navigate(target, 'example.com')
    expect(target.loadURL).toHaveBeenCalledWith('https://example.com')
    expect(out).toEqual({ ok: true, detail: 'Loaded https://example.com' })
  })

  it('refuses an empty url without touching the browser', async () => {
    const target = fake(null)
    const out = await navigate(target, '')
    expect(target.loadURL).not.toHaveBeenCalled()
    expect(out.ok).toBe(false)
  })

  it('returns a load failure as a value, never a throw', async () => {
    const target = fake(null)
    target.loadURL = vi.fn(async () => {
      throw new Error('ERR_NAME_NOT_RESOLVED')
    })
    const out = await navigate(target, 'https://nope.invalid')
    expect(out).toMatchObject({ ok: false, reason: 'error' })
    expect(out.detail).toContain('ERR_NAME_NOT_RESOLVED')
  })
})

describe('click', () => {
  it('addresses an indexed element through the tag perception left behind', async () => {
    const target = fake(true)
    const out = await click(target, { kind: 'index', idx: 7 })
    expect(target.code).toContain('data-sylor-idx="7"')
    expect(out).toEqual({ ok: true, detail: 'Clicked element #7.' })
  })

  it('prefers an exact label match over a substring one', async () => {
    // Otherwise "Send" would hit "Resend" — a different, worse action.
    const target = fake(true)
    await click(target, { kind: 'label', label: 'Send' })
    expect(target.code).toContain('nameOf(n) === want')
    expect(target.code).toContain('indexOf(want)')
    expect(target.code.indexOf('nameOf(n) === want')).toBeLessThan(
      target.code.indexOf('indexOf(want)')
    )
  })

  it('scrolls the element into view first', async () => {
    // A click on an off-screen element is accepted by the DOM but is not what the
    // user watches happen, and some sites bind their handler to the scroll.
    const target = fake(true)
    await click(target, { kind: 'index', idx: 1 })
    expect(target.code).toContain('scrollIntoView')
  })

  it('reports a miss as not-found so the model can re-read the page', async () => {
    const out = await click(fake(false), { kind: 'label', label: 'Ghost' })
    expect(out).toEqual({
      ok: false,
      reason: 'not-found',
      detail: '"Ghost" is not on the page.'
    })
  })

  it('turns a page-side throw into an error outcome', async () => {
    const out = await click(fake(new Error('detached frame')), { kind: 'index', idx: 2 })
    expect(out).toMatchObject({ ok: false, reason: 'error' })
  })
})

describe('type', () => {
  it('sets the value through the prototype setter and fires input + change', async () => {
    // React ignores a plain `el.value =`, so this is what makes typing real.
    const target = fake(true)
    const out = await typeInto(target, { kind: 'label', label: 'Search' }, 'electron')
    expect(target.code).toContain("getOwnPropertyDescriptor(proto, 'value')")
    expect(target.code).toContain("new Event('input'")
    expect(target.code).toContain("new Event('change'")
    expect(target.code).toContain('"electron"')
    expect(out).toEqual({ ok: true, detail: 'Typed into "Search".' })
  })

  it('only presses Enter when asked, and says so', async () => {
    // The Enter branch is always emitted; `submit` compiles into the literal that
    // gates it, so that condition is what the test has to read.
    const quiet = fake(true)
    const out = await typeInto(quiet, { kind: 'index', idx: 1 }, 'hi')
    expect(quiet.code).toContain('if (false)')
    expect(out.detail).not.toContain('Enter')

    const submitted = fake(true)
    const sent = await typeInto(submitted, { kind: 'index', idx: 1 }, 'hi', true)
    expect(submitted.code).toContain('if (true)')
    expect(submitted.code).toContain('requestSubmit')
    expect(sent.detail).toContain('pressed Enter')
  })

  it('refuses a password field from inside the page', async () => {
    // The executor screens the field NAME, but only the page knows its type — this
    // is the second line of defence, and it must read as a refusal, not a miss.
    const out = await typeInto(fake('sensitive'), { kind: 'label', label: 'pw' }, 'hunter2')
    expect(out).toMatchObject({ ok: false, reason: 'refused' })
    expect(out.detail).toContain('never types credentials')
  })

  it('screens credential-ish field names before the page is even asked', () => {
    for (const name of ['Password', 'card number', 'CVV', 'otp code', 'API token', 'SSN']) {
      expect(SENSITIVE_FIELD_RE.test(name.toLowerCase())).toBe(true)
    }
    for (const name of ['email', 'search', 'subject', 'message']) {
      expect(SENSITIVE_FIELD_RE.test(name)).toBe(false)
    }
  })

  it('escapes the typed text so a quote cannot break out of the expression', async () => {
    const target = fake(true)
    await typeInto(target, { kind: 'index', idx: 1 }, 'she said "hi"; drop()')
    expect(target.code).toContain(JSON.stringify('she said "hi"; drop()'))
  })
})

describe('scroll', () => {
  it('moves about a viewport, instantly, and says how far', async () => {
    const target = fake(640)
    const out = await scroll(target, 'down')
    expect(target.code).toContain('window.innerHeight*0.8')
    expect(target.code).not.toContain('smooth')
    expect(out).toEqual({ ok: true, detail: 'Scrolled down (640px).' })
  })

  it('tells the agent it has hit the end instead of letting it loop', async () => {
    // "The page did not move" in the result is what stops the model re-issuing the
    // same scroll until it runs out of steps.
    expect((await scroll(fake(0), 'down')).detail).toContain('already at the bottom')
    expect((await scroll(fake(0), 'up')).detail).toContain('already at the top')
  })

  it('scrolls up with a negative delta', async () => {
    const target = fake(-500)
    await scroll(target, 'up')
    expect(target.code).toContain('-window.innerHeight*0.8')
  })
})
