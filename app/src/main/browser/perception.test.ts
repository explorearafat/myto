/**
 * Page perception — the ladder that decides what the model gets to see.
 *
 * The in-page scan is the part worth testing hardest, and it is testable for real:
 * the tests run under jsdom, so {@link scanExpression} is evaluated against an
 * actual document rather than asserted about as a string. That matters because the
 * scan is where the security properties live — a password's *value* being
 * structurally unreachable is a claim about what the code does on a page, not about
 * how it reads.
 *
 * Two jsdom gaps have to be filled first: it lays nothing out (every
 * `getBoundingClientRect` is 0×0, which the scan reads as "hidden") and it has no
 * `innerText`. Both are stubbed below, and the stubs are the reason a "visible"
 * element is one this file says is visible.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserTarget } from './target'
import {
  captureDataUrl,
  hasSignal,
  MAX_ELEMENTS,
  MAX_TEXT,
  perceivePage,
  safeTitle,
  safeUrl,
  scanExpression,
  type PerceptionSnapshot
} from './perception'

/** The scan's return shape, as the guest hands it back. */
type Scan = Omit<PerceptionSnapshot, 'mode'>

/** Run the real in-page scan against the current jsdom document. */
function scan(wantText = true, maxText = MAX_TEXT, maxElements = MAX_ELEMENTS): Scan | null {
  return new Function(`return ${scanExpression(wantText, maxText, maxElements)}`)() as Scan | null
}

/**
 * jsdom supplies a real DOM at *runtime*, but the main-process tsconfig has no `dom`
 * lib — deliberately, because main genuinely has no DOM and leaving it out keeps a
 * stray `document` in `src/main` a type error. So this file declares exactly the
 * globals it touches instead of widening the whole program's libs.
 */
interface DomNode {
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  textContent: string | null
}
interface DomStore {
  setItem(key: string, value: string): void
  clear(): void
}
declare const document: {
  title: string
  cookie: string
  body: { innerHTML: string }
  querySelectorAll(selector: string): Iterable<DomNode>
}
declare const location: { href: string }
declare const localStorage: DomStore
declare const sessionStorage: DomStore
declare const Element: { prototype: { getBoundingClientRect: (this: DomNode) => unknown } }
declare const HTMLElement: { prototype: object }

const realRect = Element.prototype.getBoundingClientRect

beforeAll(() => {
  // Layout: jsdom has none, so everything would look hidden. An element opts into
  // being invisible with data-offscreen, which is how the skip path is exercised.
  Element.prototype.getBoundingClientRect = function (this: DomNode) {
    const hidden = this.hasAttribute('data-offscreen')
    const size = hidden ? 0 : 20
    return {
      x: 0, y: 0, top: 0, left: 0, right: size, bottom: size, width: size, height: size,
      toJSON: () => ({})
    }
  }
  // innerText: not implemented in jsdom, and the DOM tier is defined in terms of it.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: DomNode) {
      return this.textContent ?? ''
    }
  })
})

afterAll(() => {
  Element.prototype.getBoundingClientRect = realRect
  delete (HTMLElement.prototype as unknown as { innerText?: unknown }).innerText
})

beforeEach(() => {
  document.title = 'Test page'
  document.body.innerHTML = ''
})

describe('hasSignal', () => {
  const s = (over: Partial<Scan>): Scan =>
    ({ url: '', title: '', text: '', elements: [], ...over }) as Scan

  it('is false for a scan that never came back', () => {
    expect(hasSignal(null, true)).toBe(false)
    expect(hasSignal(null, false)).toBe(false)
  })

  it('accepts the DOM tier on a paragraph of text OR any control', () => {
    expect(hasSignal(s({ text: 'x'.repeat(41) }), true)).toBe(true)
    expect(hasSignal(s({ elements: [{ idx: 0, tag: 'a', role: 'link', name: 'Home' }] }), true)).toBe(
      true
    )
  })

  it('rejects a page whose text is just chrome and has nothing to click', () => {
    // 40 characters of "Loading…"/cookie-banner is not a page worth answering from,
    // and falling through to the a11y tier costs one cheap extra scan.
    expect(hasSignal(s({ text: 'Loading…' }), true)).toBe(false)
    expect(hasSignal(s({ text: '   \n  ' }), true)).toBe(false)
  })

  it('accepts the accessibility tier on structure alone', () => {
    expect(hasSignal(s({ text: '', elements: [{ idx: 0, tag: 'div', role: 'button', name: 'Go' }] }), false)).toBe(true)
    expect(hasSignal(s({ text: 'lots of text '.repeat(20) }), false)).toBe(false)
  })
})

describe('scanExpression — against a real document', () => {
  it('reports the page identity, its visible text, and its controls in order', () => {
    document.body.innerHTML = `
      <h1>Inbox</h1>
      <p>You have two new messages, and one of them needs a reply before Friday.</p>
      <a href="/archive">Archive</a>
      <button>Compose</button>`
    const out = scan()!
    expect(out.title).toBe('Test page')
    expect(out.url).toBe(location.href)
    expect(out.text).toContain('needs a reply before Friday')
    expect(out.elements.map((e) => e.name)).toEqual(['Archive', 'Compose'])
    expect(out.elements.map((e) => e.role)).toEqual(['link', 'button'])
    expect(out.truncated).toBe(false)
  })

  it('tags each element with the index the agent targets it by', () => {
    // The action layer looks elements up by `data-sylor-idx`, so the tag left on
    // the page and the idx in the snapshot are one contract.
    document.body.innerHTML = '<button>A</button><button>B</button>'
    const out = scan()!
    const tagged = Array.from(document.querySelectorAll('[data-sylor-idx]')).map((el) =>
      el.getAttribute('data-sylor-idx')
    )
    expect(tagged).toEqual(['0', '1'])
    expect(out.elements.map((e) => e.idx)).toEqual([0, 1])
  })

  it('skips what the user cannot see, and does not spend an index on it', () => {
    document.body.innerHTML = `
      <button data-offscreen>Zero sized</button>
      <button style="display:none">Displayed none</button>
      <button style="visibility:hidden">Invisible</button>
      <button>Real</button>`
    const out = scan()!
    expect(out.elements).toHaveLength(1)
    expect(out.elements[0]).toMatchObject({ idx: 0, name: 'Real' })
  })

  it('never returns the value of a field — only that it is sensitive', () => {
    // The security property, stated as a test: a password, a card number and a
    // token are structurally unreachable, whatever the model asks for.
    document.body.innerHTML = `
      <input type="password" name="password" value="hunter2">
      <input type="text" name="cardNumber" value="4111111111111111">
      <input type="hidden" name="csrf" value="tok_abc123">
      <input type="text" name="email" value="me@example.com">`
    const out = scan()!
    const json = JSON.stringify(out)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('4111111111111111')
    expect(json).not.toContain('tok_abc123')
    // Even a perfectly ordinary field's contents stay in the page.
    expect(json).not.toContain('me@example.com')
    // The two visible secrets are surfaced as sensitive rather than as values. The
    // hidden input never reaches that branch at all — `display:none` drops it one
    // check earlier, which is the same answer by a shorter route.
    expect(out.elements.filter((e) => e.name.includes('[sensitive'))).toHaveLength(2)
    expect(out.elements.map((e) => e.type)).not.toContain('hidden')
  })

  it('does not read cookies or storage', () => {
    document.cookie = 'session=topsecretcookie'
    localStorage.setItem('auth', 'topsecretlocal')
    sessionStorage.setItem('auth', 'topsecretsession')
    document.body.innerHTML = '<p>An ordinary page with quite enough words to have signal.</p>'
    const json = JSON.stringify(scan())
    expect(json).not.toContain('topsecretcookie')
    expect(json).not.toContain('topsecretlocal')
    expect(json).not.toContain('topsecretsession')
    // Belt and braces: the emitted code never names them either.
    const code = scanExpression(true, MAX_TEXT, MAX_ELEMENTS)
    expect(code).not.toContain('document.cookie')
    expect(code).not.toContain('localStorage')
    expect(code).not.toContain('sessionStorage')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('names a control the way a screen reader would, preferring the explicit label', () => {
    document.body.innerHTML = `
      <span id="lbl">Search the archive</span>
      <button aria-label="Close dialog">×</button>
      <button aria-labelledby="lbl">?</button>
      <button title="Refresh now">⟳</button>
      <input placeholder="Your email">
      <img src="x.png" alt="Logo" role="img">
      <button>Plain text label</button>`
    const names = scan()!.elements.map((e) => e.name)
    expect(names).toContain('Close dialog')
    expect(names).toContain('Search the archive')
    expect(names).toContain('Refresh now')
    expect(names).toContain('Your email')
    expect(names).toContain('Logo')
    expect(names).toContain('Plain text label')
  })

  it('flags what can be typed into', () => {
    document.body.innerHTML = `
      <input type="text" placeholder="Text">
      <input type="checkbox" aria-label="Check">
      <textarea placeholder="Body"></textarea>
      <div contenteditable="true" role="textbox" aria-label="Rich">x</div>
      <button>Not editable</button>`
    const byName = new Map(scan()!.elements.map((e) => [e.name, e]))
    expect(byName.get('Text')?.editable).toBe(true)
    expect(byName.get('Body')?.editable).toBe(true)
    expect(byName.get('Check')?.editable).toBe(false)
    expect(byName.get('Not editable')?.editable).toBe(false)
    // The contenteditable case rests on `isContentEditable`, which jsdom does not
    // implement — so it is asserted only as far as this environment can prove:
    // it is perceived, with the role it declares.
    expect(byName.get('Rich')?.role).toBe('textbox')
  })

  it('maps implicit roles, and lets an explicit role win', () => {
    document.body.innerHTML = `
      <a href="/x">Link</a>
      <textarea aria-label="Area"></textarea>
      <select aria-label="Pick"></select>
      <input type="checkbox" aria-label="Box">
      <input type="submit" aria-label="Go">
      <div role="tab" tabindex="0">Tab</div>
      <a href="/y" role="button">Actually a button</a>`
    const byName = new Map(scan()!.elements.map((e) => [e.name, e.role]))
    expect(byName.get('Link')).toBe('link')
    expect(byName.get('Area')).toBe('textbox')
    expect(byName.get('Pick')).toBe('combobox')
    expect(byName.get('Box')).toBe('checkbox')
    expect(byName.get('Go')).toBe('submit')
    expect(byName.get('Tab')).toBe('tab')
    expect(byName.get('Actually a button')).toBe('button')
  })

  it('marks a dead control so the agent does not waste a step on it', () => {
    document.body.innerHTML = `
      <button disabled>Off</button>
      <button aria-disabled="true">Also off</button>
      <button>On</button>`
    const byName = new Map(scan()!.elements.map((e) => [e.name, e.disabled]))
    expect(byName.get('Off')).toBe(true)
    expect(byName.get('Also off')).toBe(true)
    expect(byName.get('On')).toBe(false)
  })

  it('clips a long accessible name instead of pasting a paragraph into the list', () => {
    document.body.innerHTML = `<button>${'word '.repeat(60)}</button>`
    const name = scan()!.elements[0].name
    expect(name.length).toBeLessThanOrEqual(141)
    expect(name.endsWith('…')).toBe(true)
  })

  it('caps the element list and says it clipped', () => {
    document.body.innerHTML = Array.from({ length: 6 }, (_, i) => `<button>B${i}</button>`).join('')
    const out = scan(true, MAX_TEXT, 4)!
    expect(out.elements).toHaveLength(4)
    expect(out.truncated).toBe(true)
  })

  it('caps the page text and says it clipped', () => {
    document.body.innerHTML = `<p>${'x'.repeat(500)}</p>`
    const out = scan(true, 100, MAX_ELEMENTS)!
    expect(out.text).toHaveLength(100)
    expect(out.truncated).toBe(true)
  })

  it('collapses runs of blank lines so the model is not paid to read whitespace', () => {
    document.body.innerHTML = '<p>Top</p>\n\n\n\n\n<p>Bottom</p>'
    expect(scan()!.text).not.toMatch(/\n{3,}/)
  })

  it('returns the controls but no text on the accessibility pass', () => {
    document.body.innerHTML = '<p>Plenty of visible words right here.</p><button>Go</button>'
    const out = scan(false)!
    expect(out.text).toBe('')
    expect(out.elements.map((e) => e.name)).toEqual(['Go'])
  })
})

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/** A target whose guest answers each pass from `replies`, keyed by wantText. */
function target(replies: {
  dom?: Scan | null
  a11y?: Scan | null
  capture?: string | null
  urlThrows?: boolean
}): BrowserTarget {
  return {
    loadURL: async () => {},
    getURL: () => {
      if (replies.urlThrows) throw new Error('destroyed')
      return 'https://example.com/here'
    },
    getTitle: () => {
      if (replies.urlThrows) throw new Error('destroyed')
      return 'Here'
    },
    isLoading: () => false,
    executeJavaScript: async (code: string) =>
      code.includes('if (true)') ? (replies.dom ?? null) : (replies.a11y ?? null),
    capturePage: async () => {
      if (replies.capture === null) throw new Error('capture failed')
      const url = replies.capture ?? 'data:image/png;base64,QUJD'
      return { toDataURL: () => url, isEmpty: () => !url.split(',')[1] }
    }
  }
}

const rich: Scan = {
  url: 'https://example.com/here',
  title: 'Here',
  text: 'A page with plainly enough readable prose on it to clear the signal bar.',
  elements: [{ idx: 0, tag: 'button', role: 'button', name: 'Go' }]
}
const structureOnly: Scan = { ...rich, text: '' }

describe('perceivePage — the priority ladder', () => {
  it('stops at the DOM tier when the page has readable text', async () => {
    const snap = await perceivePage(target({ dom: rich }))
    expect(snap.mode).toBe('dom')
    expect(snap.text).toContain('readable prose')
    expect(snap.imageDataUrl).toBeUndefined()
  })

  it('falls to accessibility when the text is thin but the structure is not', async () => {
    // An SPA whose content is all widgets: the a11y pass is a second cheap scan,
    // and far better than a screenshot.
    const snap = await perceivePage(target({ dom: { ...rich, text: '', elements: [] }, a11y: structureOnly }))
    expect(snap.mode).toBe('accessibility')
    expect(snap.elements).toHaveLength(1)
  })

  it('falls to vision only when there is nothing to read at all', async () => {
    // A canvas app or a cross-origin frame. The screenshot is an honest last
    // resort, and it says so via the mode.
    const snap = await perceivePage(target({ dom: null, a11y: null }))
    expect(snap.mode).toBe('vision')
    expect(snap.imageDataUrl).toBe('data:image/png;base64,QUJD')
    expect(snap.text).toBe('')
    expect(snap.elements).toEqual([])
    // It still knows where it is, so the card and the transcript stay truthful.
    expect(snap.url).toBe('https://example.com/here')
    expect(snap.title).toBe('Here')
  })

  it('skips both text tiers when the caller explicitly wants pixels', async () => {
    const snap = await perceivePage(target({ dom: rich }), { preferVision: true })
    expect(snap.mode).toBe('vision')
    expect(snap.imageDataUrl).toBeDefined()
  })

  it('returns a usable vision snapshot even when the capture itself fails', async () => {
    // Never throw out of perception: the agent loop turns the result into its next
    // observation, and an exception there ends the turn.
    const snap = await perceivePage(target({ dom: null, a11y: null, capture: null }))
    expect(snap.mode).toBe('vision')
    expect(snap.imageDataUrl).toBeUndefined()
  })

  it('survives a target that has been destroyed mid-step', async () => {
    const snap = await perceivePage(target({ dom: null, a11y: null, urlThrows: true }))
    expect(snap.mode).toBe('vision')
    expect(snap.url).toBe('')
    expect(snap.title).toBe('')
  })
})

describe('captureDataUrl / safeUrl / safeTitle', () => {
  it('drops an empty capture rather than sending a blank image', async () => {
    await expect(captureDataUrl(target({ capture: 'data:image/png;base64,' }))).resolves.toBeUndefined()
  })

  it('returns the data url of a real capture', async () => {
    await expect(captureDataUrl(target({}))).resolves.toBe('data:image/png;base64,QUJD')
  })

  it('reads url and title without ever throwing', () => {
    const dead = target({ urlThrows: true })
    expect(safeUrl(dead)).toBe('')
    expect(safeTitle(dead)).toBe('')
    const live = target({})
    expect(safeUrl(live)).toBe('https://example.com/here')
    expect(safeTitle(live)).toBe('Here')
  })
})
