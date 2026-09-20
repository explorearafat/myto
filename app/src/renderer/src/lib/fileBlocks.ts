/**
 * Splits an assistant reply into a sequence of prose runs and "file" blocks, so
 * the transcript can render generated files as downloadable cards (see FileCard)
 * while everything else renders as ordinary Markdown.
 *
 * A fenced code block is treated as a FILE only when its info line names a path —
 * the convention the model is taught in main/status.ts (`FILE_PROTOCOL_SYSTEM_PROMPT`):
 *
 *     ```python app.py            → { lang:'python', path:'app.py' }
 *     ```html templates/index.html → { lang:'html', path:'templates/index.html' }
 *     ```app.py                    → { lang:'',      path:'app.py' }  (lang inferred later)
 *
 * A plain ```` ```js ```` snippet (no path) is left inside the prose untouched, so it
 * still renders as a normal code block. The parser is streaming-aware: a file block
 * whose closing fence has not arrived yet is emitted with `complete: false`, letting
 * the card show a live "Writing…" state as its body streams in.
 *
 * Pure and side-effect free; unit-tested in fileBlocks.test.ts.
 */

/** A run of ordinary Markdown between (or around) file blocks. */
export interface ProseSegment {
  kind: 'prose'
  text: string
}

/** A complete-file code block pulled out for card rendering. */
export interface FileSegment {
  kind: 'file'
  /** Highlight language from the info line, or '' when only a path was given. */
  lang: string
  /** Relative path with extension, e.g. `static/style.css`. */
  path: string
  /** The block body (no fences), exactly as written. */
  code: string
  /** False while the closing fence has not streamed in yet. */
  complete: boolean
}

/**
 * A tool call and (once it arrives) its result, pulled out for card rendering.
 * The main process writes tool use into the reply as two adjacent fenced blocks —
 * a `sylor:tool` call block and a `sylor:tool_result <name>` result block (see
 * main/tools/toolParser.ts) — which this parser coalesces into one segment.
 */
export interface ToolSegment {
  kind: 'tool'
  /** Tool name (from the call, or the result's info line as a fallback), or null. */
  name: string | null
  /** Parsed `input` from the call; the raw body string if the JSON was malformed; undefined for a result-only block. */
  input: unknown
  /** The result text, or null while only the call has streamed in (card shows "Running…"). */
  result: string | null
  /** False while the most recent block's (call, or result once present) closing fence hasn't arrived. */
  complete: boolean
}

export type Segment = ProseSegment | FileSegment | ToolSegment

/** Filenames that legitimately carry no extension. */
const KNOWN_EXTENSIONLESS = new Set([
  'Dockerfile',
  'Makefile',
  'Rakefile',
  'Gemfile',
  'Procfile'
])

/** Whether a token from a fence info line looks like a file path rather than a language. */
function isFilenameLike(token: string): boolean {
  if (token.includes('/')) return true // has a directory segment
  if (/^\.[A-Za-z0-9]/.test(token)) return true // dotfile: .gitignore, .env
  if (/\.[A-Za-z0-9]+$/.test(token)) return true // has an extension
  return KNOWN_EXTENSIONLESS.has(token)
}

/** Parse a fence info line into a file's {lang, path}, or null when it is not a file. */
function parseInfo(info: string): { lang: string; path: string } | null {
  const trimmed = info.trim()
  if (trimmed === '') return null
  const tokens = trimmed.split(/\s+/)
  if (tokens.length >= 2) {
    return isFilenameLike(tokens[1]) ? { lang: tokens[0], path: tokens[1] } : null
  }
  // A single token is either a bare language (```python) or a bare path (```app.py).
  return isFilenameLike(tokens[0]) ? { lang: '', path: tokens[0] } : null
}

/**
 * Recognise a tool-protocol fence info line. `sylor:tool` opens a call block;
 * `sylor:tool_result <name>` opens the matching result block. Returns null for
 * anything else so ordinary fences fall through to the file/prose logic.
 */
function parseToolInfo(info: string): { kind: 'call' } | { kind: 'result'; name: string | null } | null {
  const trimmed = info.trim()
  if (trimmed === 'sylor:tool') return { kind: 'call' }
  if (trimmed === 'sylor:tool_result' || trimmed.startsWith('sylor:tool_result ')) {
    const name = trimmed.slice('sylor:tool_result'.length).trim()
    return { kind: 'result', name: name || null }
  }
  return null
}

/** Parse a call block's JSON body into `{name, input}`; keep the raw body if it won't parse. */
function parseCallBody(body: string): { name: string | null; input: unknown } {
  const trimmed = body.trim()
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const name = typeof obj.tool === 'string' && obj.tool.trim() ? obj.tool.trim() : null
      return { name, input: 'input' in obj ? obj.input : undefined }
    }
  } catch {
    // fall through: hand back the raw text so the card can still show something
  }
  return { name: null, input: trimmed || undefined }
}

/** Matches an opening/closing fence line: 3+ backticks, then the info string. */
const FENCE = /^(`{3,})[ \t]*(.*)$/

/**
 * Parse `md` into ordered prose + file segments. Prose segments preserve the
 * original text (including non-file code blocks) so Markdown renders them
 * identically; empty/whitespace-only prose is dropped. A reply with no file
 * blocks yields a single prose segment (i.e. today's behaviour).
 */
export function parseFileBlocks(md: string): Segment[] {
  const lines = md.split('\n')
  const segments: Segment[] = []
  let prose: string[] = []

  const flushProse = (): void => {
    const text = prose.join('\n')
    if (text.trim() !== '') segments.push({ kind: 'prose', text })
    prose = []
  }

  let i = 0
  while (i < lines.length) {
    const open = FENCE.exec(lines[i])
    if (!open) {
      prose.push(lines[i])
      i++
      continue
    }

    const fence = open[1]
    const tool = parseToolInfo(open[2])
    const file = tool ? null : parseInfo(open[2])

    // Scan forward for a closing fence of at least the same length.
    const body: string[] = []
    let j = i + 1
    let closed = false
    for (; j < lines.length; j++) {
      const close = /^(`{3,})[ \t]*$/.exec(lines[j])
      if (close && close[1].length >= fence.length) {
        closed = true
        break
      }
      body.push(lines[j])
    }

    if (tool) {
      flushProse()
      const bodyText = body.join('\n')
      if (tool.kind === 'call') {
        const { name, input } = parseCallBody(bodyText)
        segments.push({ kind: 'tool', name, input, result: null, complete: closed })
      } else {
        // Coalesce onto the preceding call segment when it is still awaiting a
        // result; otherwise stand alone (a result with no call is degenerate but
        // shouldn't be dropped).
        const last = segments[segments.length - 1]
        if (last && last.kind === 'tool' && last.result === null) {
          last.result = bodyText
          last.complete = closed
          if (!last.name) last.name = tool.name
        } else {
          segments.push({ kind: 'tool', name: tool.name, input: undefined, result: bodyText, complete: closed })
        }
      }
      i = closed ? j + 1 : j
    } else if (file) {
      flushProse()
      segments.push({
        kind: 'file',
        lang: file.lang,
        path: file.path,
        code: body.join('\n'),
        complete: closed
      })
      i = closed ? j + 1 : j // resume after the close, or at EOF
    } else {
      // Not a file: keep the block verbatim in the prose stream.
      prose.push(lines[i], ...body)
      if (closed) {
        prose.push(lines[j])
        i = j + 1
      } else {
        i = j
      }
    }
  }

  flushProse()
  return segments
}

/** Last path segment of a file path (e.g. `templates/index.html` → `index.html`). */
export function basename(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = norm.lastIndexOf('/')
  return slash >= 0 ? norm.slice(slash + 1) : norm
}
