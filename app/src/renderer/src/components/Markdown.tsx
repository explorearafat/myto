import { createContext, useContext, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/**
 * Renders assistant messages as GitHub-flavored Markdown with syntax-highlighted
 * code blocks — the ChatGPT/Claude reading experience. All processing is local
 * (react-markdown + remark-gfm + rehype-highlight, bundled offline); raw HTML in
 * the source is NOT rendered (react-markdown escapes it by default), so a model
 * reply can never inject markup.
 *
 * react-markdown 10 dropped the `inline` prop that older versions passed to the
 * `code` renderer, so block-vs-inline is detected structurally: the `pre`
 * override sets {@link BlockContext} to true around its children, and the `code`
 * override reads it. A fenced block always nests `code` inside `pre`; inline
 * code never does — robust regardless of language or highlight quirks.
 */

/** True while rendering inside a fenced code block (set by the `pre` override). */
const BlockContext = createContext(false)

/** A hast node, minimally typed for walking the tree the plugins produce. */
interface HastNode {
  type?: string
  value?: string
  tagName?: string
  properties?: { className?: string[] | string }
  children?: HastNode[]
}

/** Recursively collect the text content of a hast node (ignores token spans). */
function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  if (!node.children) return ''
  return node.children.map(hastText).join('')
}

/** The language of a fenced block, from its `<code class="language-x">` child. */
function langOf(preNode: HastNode | undefined): string {
  const code = preNode?.children?.find((c) => c.tagName === 'code')
  const raw = code?.properties?.className
  const classes = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s+/) : []
  const lang = classes.find((c) => c.startsWith('language-'))
  return lang ? lang.slice('language-'.length) : ''
}

/** Copy-to-clipboard button shown in each code block's header. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted transition-colors hover:bg-surface hover:text-text"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/**
 * Renders a `code` node as either a highlighted block child (keeps
 * rehype-highlight's `hljs language-*` classes) or an inline pill, chosen by
 * {@link BlockContext}. Extracted as an uppercase component so the `useContext`
 * hook obeys the rules of hooks (react-markdown calls the override as a
 * component, but a lowercase `code(...)` closure isn't recognized as one).
 */
function CodeToken({
  className,
  children
}: {
  className?: string
  children?: ReactNode
}): ReactNode {
  const isBlock = useContext(BlockContext)
  if (isBlock) {
    // Inside a <pre>: keep rehype-highlight's `hljs language-*` classes intact.
    return <code className={className}>{children}</code>
  }
  return (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-primary">
      {children}
    </code>
  )
}

const components: Components = {
  // Fenced code block: styled container with a language label + copy button. The
  // children (the rendered <code>) render inside a BlockContext so the `code`
  // override below knows to keep highlight classes rather than draw an inline pill.
  pre({ node, children }) {
    const src = node as HastNode | undefined
    const lang = langOf(src)
    const raw = hastText(src).replace(/\n$/, '')
    return (
      <div className="my-3 overflow-hidden rounded-lg border border-border/70">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted">
            {lang || 'code'}
          </span>
          <CopyButton text={raw} />
        </div>
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed">
          <BlockContext.Provider value={true}>{children}</BlockContext.Provider>
        </pre>
      </div>
    )
  },
  code: CodeToken,
  // Open links in the OS browser (main-process setWindowOpenHandler routes
  // window.open → shell.openExternal), never inside the app window.
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href) window.open(href, '_blank', 'noopener,noreferrer')
        }}
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {children}
      </a>
    )
  },
  p({ children }) {
    return <p className="my-2 first:mt-0 last:mb-0">{children}</p>
  },
  ul({ children }) {
    return <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted">{children}</ul>
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted">{children}</ol>
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>
  },
  h1({ children }) {
    return <h1 className="mb-2 mt-3 text-[16px] font-semibold first:mt-0">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="mb-1.5 mt-3 text-[14px] font-semibold first:mt-0">{children}</h3>
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-muted italic">
        {children}
      </blockquote>
    )
  },
  hr() {
    return <hr className="my-3 border-border" />
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">{children}</table>
      </div>
    )
  },
  thead({ children }) {
    return <thead className="border-b border-border text-left">{children}</thead>
  },
  th({ children }) {
    return <th className="px-2 py-1 font-semibold">{children}</th>
  },
  td({ children }) {
    return <td className="border-t border-border px-2 py-1">{children}</td>
  },
  strong({ children }) {
    return <strong className="font-semibold text-text">{children}</strong>
  },
  // Inline images — generated pictures (Feature B) and rasterized document pages (A2b)
  // arrive as Markdown `![alt](data:…|url)`. Constrain and frame them so a full-size
  // generation doesn't overflow the reply column. `data:` sources render locally (no
  // network); a remote URL loads normally. loading=lazy keeps a long reply light.
  img({ src, alt }) {
    if (typeof src !== 'string' || !src) return null
    return (
      <img
        src={src}
        alt={typeof alt === 'string' ? alt : ''}
        loading="lazy"
        className="my-2 max-h-[70vh] max-w-full rounded-lg border border-border/70"
      />
    )
  }
}

/**
 * Body-only code components: the highlighted `<pre>` with no language label or
 * copy header. Used by {@link CodeBody} so a FileCard (which draws its own header
 * with the logo, path, type badge and its own copy/download) doesn't render the
 * duplicate chrome the full `pre` override above adds.
 */
const bodyComponents: Components = {
  pre({ children }) {
    return (
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed">
        <BlockContext.Provider value={true}>{children}</BlockContext.Provider>
      </pre>
    )
  },
  code: CodeToken
}

/**
 * The shortest backtick fence that can wrap `code` without a run of backticks
 * inside it closing the block early (CommonMark: a fence must be longer than any
 * backtick run it contains). Lets a generated Markdown file that itself contains
 * ``` code fences still highlight as one block.
 */
function fenceFor(code: string): string {
  let max = 0
  for (const run of code.matchAll(/`+/g)) max = Math.max(max, run[0].length)
  return '`'.repeat(Math.max(3, max + 1))
}

/**
 * Render a single code string as a highlighted block body — same rehype-highlight
 * pipeline as {@link Markdown}, but without the header chrome. `lang` is a
 * highlight.js language hint (e.g. `python`, `html`); an unknown or empty value
 * degrades to an unhighlighted block (ignoreMissing) rather than throwing.
 */
export function CodeBody({ code, lang }: { code: string; lang?: string }): ReactNode {
  const fence = fenceFor(code)
  const fenced = `${fence}${lang ?? ''}\n${code}\n${fence}`
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
      components={bodyComponents}
    >
      {fenced}
    </ReactMarkdown>
  )
}

/** Render Markdown `content` with the shared component overrides + GFM + highlight. */
export function Markdown({ content }: { content: string }): ReactNode {
  return (
    <div className="text-[13px] leading-relaxed text-text/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
