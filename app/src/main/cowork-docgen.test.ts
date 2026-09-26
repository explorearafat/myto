import { describe, it, expect } from 'vitest'
import {
  markdownToHtml,
  escapeHtml,
  documentHtml,
  slidesHtml,
  splitSlides,
  withExtension,
  firstHeading,
  pdfOptionsFor
} from './cowork-docgen'

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;'
    )
  })
})

describe('markdownToHtml — blocks', () => {
  it('renders ATX headings h1..h6', () => {
    expect(markdownToHtml('# Title')).toBe('<h1>Title</h1>')
    expect(markdownToHtml('###### Deep')).toBe('<h6>Deep</h6>')
  })
  it('gathers a wrapped paragraph into one <p> joined by spaces', () => {
    expect(markdownToHtml('one\ntwo')).toBe('<p>one two</p>')
  })
  it('renders a horizontal rule', () => {
    expect(markdownToHtml('---')).toBe('<hr>')
  })
  it('renders a fenced code block with a language class and escapes its body', () => {
    expect(markdownToHtml('```ts\nconst x = 1 < 2\n```')).toBe(
      '<pre><code class="language-ts">const x = 1 &lt; 2</code></pre>'
    )
  })
  it('renders a blockquote by recursing on its stripped content', () => {
    expect(markdownToHtml('> hi')).toBe('<blockquote><p>hi</p></blockquote>')
  })
})

describe('markdownToHtml — inline', () => {
  it('renders bold, italic, and inline code', () => {
    expect(markdownToHtml('**b** and *i* and `c`')).toBe(
      '<p><strong>b</strong> and <em>i</em> and <code>c</code></p>'
    )
  })
  it('does not format inside a code span', () => {
    expect(markdownToHtml('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
  })
  it('renders links and images', () => {
    expect(markdownToHtml('[t](http://e.com)')).toContain('<a href="http://e.com">t</a>')
    expect(markdownToHtml('![alt](http://e.com/i.png)')).toContain(
      '<img alt="alt" src="http://e.com/i.png">'
    )
  })
  it('escapes a quote in link text so it cannot break out of the attribute', () => {
    expect(markdownToHtml('[a"b](http://e.com)')).toContain('<a href="http://e.com">a&quot;b</a>')
  })
})

describe('markdownToHtml — lists and tables', () => {
  it('renders an unordered list', () => {
    expect(markdownToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
  })
  it('renders an ordered list', () => {
    expect(markdownToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })
  it('renders a GFM table with per-column alignment', () => {
    const html = markdownToHtml('| A | B |\n|:--|--:|\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th style="text-align:left">A</th>')
    expect(html).toContain('<th style="text-align:right">B</th>')
    expect(html).toContain('<td style="text-align:left">1</td>')
  })
  it('does not mistake a table header line for a paragraph', () => {
    expect(markdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |').startsWith('<table>')).toBe(true)
  })
})

describe('splitSlides', () => {
  it('splits on a rule line, trims, and drops empty chunks', () => {
    expect(splitSlides('# One\n\n---\n\n# Two')).toEqual(['# One', '# Two'])
  })
  it('drops leading, trailing, and doubled separators', () => {
    expect(splitSlides('---\n\na\n\n---\n---\n\nb\n\n---')).toEqual(['a', 'b'])
  })
  it('treats content with no separators as a single slide', () => {
    expect(splitSlides('just one')).toEqual(['just one'])
  })
})

describe('firstHeading', () => {
  it('returns the first heading text', () => {
    expect(firstHeading('intro\n\n## Real Title\n\nbody')).toBe('Real Title')
  })
  it('is empty when there is no heading', () => {
    expect(firstHeading('no heading here')).toBe('')
  })
})

describe('documentHtml', () => {
  it('wraps rendered markdown in a full page with the document CSS', () => {
    const html = documentHtml({ markdown: '# Hello\n\nbody' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Hello</title>')
    expect(html).toContain('<main class="doc">')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('.doc{max-width:720px')
  })
  it('prefers an explicit title and HTML-escapes it', () => {
    expect(documentHtml({ title: 'A & B', markdown: '# H' })).toContain('<title>A &amp; B</title>')
  })
})

describe('slidesHtml', () => {
  it('emits one .slide section per chunk with the slides CSS', () => {
    const html = slidesHtml({ title: 'Deck', markdown: '# One\n\n---\n\n# Two' })
    expect(html).toContain('<title>Deck</title>')
    expect((html.match(/<section class="slide">/g) || []).length).toBe(2)
    expect(html).toContain('.slide{width:100vw')
  })
})

describe('withExtension', () => {
  it('replaces an existing extension', () => {
    expect(withExtension('report.md', 'pdf')).toBe('report.pdf')
    expect(withExtension('a/b/c.html', 'pdf')).toBe('a/b/c.pdf')
  })
  it('adds an extension when there is none', () => {
    expect(withExtension('report', 'pdf')).toBe('report.pdf')
  })
  it('leaves a dotfile stem intact', () => {
    expect(withExtension('.env', 'pdf')).toBe('.env.pdf')
  })
  it('accepts a leading dot on the ext and handles backslash paths', () => {
    expect(withExtension('a\\b\\c.md', '.pdf')).toBe('a\\b\\c.pdf')
  })
})

describe('pdfOptionsFor', () => {
  it('documents portrait, slides landscape; both print background at zero margins', () => {
    const doc = pdfOptionsFor('document')
    expect(doc.landscape).toBe(false)
    expect(doc.printBackground).toBe(true)
    expect(doc.margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
    expect(pdfOptionsFor('slides').landscape).toBe(true)
  })
})
