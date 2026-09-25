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
 * a `myto:tool` call block and a `myto:tool_result <name>` result block (see
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
 * Recognise a tool-protocol fence info line. `myto:tool` opens a call block;
 * `myto:tool_result <name>` opens the matching result block. Returns null for
 * anything else so ordinary fences fall through to the file/prose logic.
 */
function parseToolInfo(info: string): { kind: 'call' } | { kind: 'result'; name: string | null } | null {
  const trimmed = info.trim()
  if (trimmed === 'myto:tool') return { kind: 'call' }
  if (trimmed === 'myto:tool_result' || trimmed.startsWith('myto:tool_result ')) {
    const name = trimmed.slice('myto:tool_result'.length).trim()
    return { kind: 'result', name: name || null }
  }
  return null
}

/**
 * Pull the string value of a JSON key out of a possibly-incomplete body by hand,
 * honouring `\n`/`\r`/`\t`/`\"` escapes. Used by the lenient recovery below so a
 * tool call whose closing brace/fence has NOT streamed in yet still yields its
 * `path`/`content` — letting the card show the live filename and a growing +N
 * before the JSON is well-formed. Returns undefined when the key isn't present
 * (or its value hasn't started); a value still mid-stream comes back truncated,
 * which is exactly what we want to display. Order-agnostic: matches anywhere.
 */
function extractJsonString(body: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(body)
  if (!m) return undefined
  let out = ''
  for (let k = m.index + m[0].length; k < body.length; k++) {
    const ch = body[k]
    if (ch === '\\') {
      const next = body[k + 1]
      if (next === undefined) break
      out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next
      k++
      continue
    }
    if (ch === '"') return out
    out += ch
  }
  return out
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
    // fall through: try a lenient recovery, then hand back the raw text.
  }
  // Streaming: the JSON is still arriving (unclosed brace/fence) so JSON.parse fails.
  // If we can already see the tool name, recover it plus whatever string args have
  // streamed so far, so the card shows the real filename and a live +N instead of
  // waiting for the block to close. Once it closes, the exact parse above wins.
  const toolMatch = /"tool"\s*:\s*"([^"]+)"/.exec(trimmed)
  if (toolMatch) {
    const input: Record<string, string> = {}
    for (const key of ['path', 'content', 'old', 'new'] as const) {
      const value = extractJsonString(trimmed, key)
      if (value !== undefined) input[key] = value
    }
    return { name: toolMatch[1].trim() || null, input }
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

/**
 * Count lines the way the diff badges do (see ToolCard `diffCounts`): an empty
 * string is 0 lines, otherwise the newline-split length. Shared so a generated
 * file card's `+N −N` and a tool card's agree on what "a line" is.
 */
export function countLines(s: string): number {
  return s === '' ? 0 : s.split('\n').length
}

/** Last path segment of a file path (e.g. `templates/index.html` → `index.html`). */
export function basename(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = norm.lastIndexOf('/')
  return slash >= 0 ? norm.slice(slash + 1) : norm
}

/**
 * A friendly, present-tense headline for a tool round-trip — what Myto is doing,
 * with the target when there is one (e.g. "Creating ai-news.pdf", "Listing folder",
 * "Web search"). Shown on the tool card and, while the tool runs, in the live status
 * line. Lives here (not in ToolCard) so both the card and the status line share it.
 */
export function toolHeadline(tool: ToolSegment): string {
  const input = tool.input && typeof tool.input === 'object' ? (tool.input as Record<string, unknown>) : {}
  const path = typeof input.path === 'string' ? input.path : ''
  const name = basename(path)
  switch (tool.name) {
    case 'write_file':
      return name ? `Creating ${name}` : 'Creating file'
    case 'edit_file':
      return name ? `Editing ${name}` : 'Editing file'
    case 'read_file':
      return name ? `Reading ${name}` : 'Reading file'
    case 'delete_file':
      return name ? `Deleting ${name}` : 'Deleting file'
    case 'list_dir':
      return path && path !== '.' ? `Listing ${path}` : 'Listing folder'
    case 'preview': {
      const url = typeof input.url === 'string' ? input.url : ''
      if (name) return `Showing ${name} in preview`
      if (url) return `Opening ${url} in preview`
      return 'Opening preview'
    }
    case 'run_code': {
      const lang = typeof input.language === 'string' ? input.language : ''
      return lang ? `Running ${lang} code` : 'Running code'
    }
    case 'run_command': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      return cmd ? `Running ${cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd}` : 'Running command'
    }
    case 'run_dev_server': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      return cmd ? `Starting server: ${cmd.length > 32 ? `${cmd.slice(0, 32)}…` : cmd}` : 'Starting dev server'
    }
    case 'search_code': {
      const query = typeof input.query === 'string' ? input.query : ''
      return query ? `Searching for “${query.length > 32 ? `${query.slice(0, 32)}…` : query}”` : 'Searching code'
    }
    case 'find_files': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      return pattern ? `Finding ${pattern}` : 'Finding files'
    }
    case 'spawn_agent':
      return 'Delegating to a sub-agent'
    case 'web_search':
      return 'Web search'
    case 'web_fetch':
      return 'Fetch page'
    case 'wiki_search':
      return 'Wikipedia'
    default:
      return tool.name ?? 'Tool'
  }
}
