/**
 * Incremental parser for the text tool-call protocol.
 *
 * The two chat providers (gateway + Ollama) are streaming-only and neither parses
 * a native `tool_calls` array, so tool use rides the same out-of-band trick the
 * app already uses for `<status>` captions and file cards: the model emits a
 * fenced block the main process detects mid-stream, runs, and answers back with a
 * result block. This is the funnel that pulls a tool CALL out of the raw token
 * stream:
 *
 *     ```myto:tool
 *     {"tool": "web_search", "input": {"query": "webgpu 2026"}}
 *     ```
 *
 * {@link createToolCallParser} mirrors the status stripper's hold-back-tail design
 * (see main/status.ts): it forwards ordinary text immediately but holds a run that
 * could still grow into an opening `` ```myto:tool `` fence, and once the block's
 * closing fence arrives it returns the whole block plus the parsed call. The reply
 * loop (provider-ipc.ts) — not this parser — owns the terminal `done`.
 *
 * Pure and side-effect free; unit-tested in toolParser.test.ts.
 */

/** The info-line marker that opens a tool-call block (always exactly 3 backticks). */
const MARKER = '```myto:tool'

/*
 * Native-markup fallback. Some models ignore the fenced protocol above and instead
 * emit their *native* tool-call markup straight into the token stream, in three
 * shapes we have seen in the wild:
 *
 *     <invoke name="run_command">                      ← Anthropic-style invoke
 *       <parameter name="command">npm run build</parameter>
 *     </invoke>
 *
 *     <run_code>{"language":"python","code":"…"}</run_code>   ← tool-name-as-tag,
 *     <run_dev_server>{"command":"…"}</run_dev_server>          args as raw JSON
 *
 *     <parameter name="tool">{"tool":"run","command":"…"}</parameter>  ← bare
 *                                                              parameter wrapper
 *
 * They arrive dressed up in ways the fenced parser never sees: an `antml:` / `antml`
 * namespace prefix on every tag, and stray `| DSML |` token-pollution wedged in
 * around the angle brackets. Left alone this leaks into the chat as raw text and the
 * call never runs. We detect all three, strip the noise, and fold them into the SAME
 * {@link ToolCall} shape (with a synthesised canonical `` ```myto:tool `` block) so
 * everything downstream — the reply loop, the renderer's cards — is none the wiser.
 */

/**
 * Tools a model may emit as its OWN tag (`<run_code>{…}</run_code>`) instead of an
 * `<invoke>` wrapper. Only these names can open a native block — matching ANY
 * `<word>` would swallow ordinary HTML/JSX in prose. Mirrors the tool registry's
 * catalogue plus the media sub-ops some gateways expose.
 */
const NATIVE_TOOL_TAGS = [
  'write_file',
  'create_file',
  'read_file',
  'edit_file',
  'delete_file',
  'list_dir',
  'preview',
  'run_code',
  'run_command',
  'run_dev_server',
  'search_code',
  'find_files',
  'update_plan',
  'present_plan',
  'think',
  'remember',
  'spawn_agent',
  'spawn_agents',
  'ask_user',
  'web_search',
  'web_fetch',
  'wiki_search',
  'verify_file',
  'detect_runtimes',
  'scaffold_deploy',
  'create_document',
  'render_document',
  'read_document',
  'edit_notebook',
  'run_ffmpeg',
  'edit_photo',
  'edit_video',
  'transcribe_audio',
  'git_status',
  'git_commit',
  'git_diff',
  'git_log',
  'git_publish',
  'install_skill',
  'install_connector',
  'list_credentials',
  'save_credential',
  'delete_credential',
  'browser_navigate',
  'browser_snapshot',
  'browser_read',
  'browser_click',
  'browser_type',
  'search_document',
  'read_pages',
  'apply_edit_plan'
] as const

/**
 * Matches a native tool tag opener: `<invoke`, `<parameter name="tool">` (the bare
 * wrapper some models emit with the whole call as its JSON body — the lookahead
 * keeps OTHER `<parameter>` children from ever opening a block), or ANY known tool
 * name as the tag itself. Group 1 is the clean tag word; group 2 the rest of the
 * opener line.
 */
const NATIVE_OPEN_RE = new RegExp(
  `<\\s*(?:antml[:.]?)?(invoke|parameter(?=[^>]*\\bname\\s*=\\s*["']tool["'])|${NATIVE_TOOL_TAGS.join('|')})\\b([^>]*)>`,
  'i'
)

/** A completed tool call detected in the stream. */
export interface ToolCall {
  /** The exact block text (```` ```myto:tool … ``` ````) to write into the reply for the card. */
  block: string
  /** Parsed tool name, or null when the JSON was missing/malformed. */
  name: string | null
  /** The value under the call's `input` key (shape validated per-tool at run time). */
  input: unknown
  /** A human-readable parse error when `name` is null; else null. */
  error: string | null
}

/** What {@link ToolCallParser.push} returns for one delta. */
export interface ToolParseResult {
  /** Text safe to forward to the reply now (everything before any tool fence). */
  text: string
  /** A completed tool call found in this push, or null. */
  call: ToolCall | null
}

export interface ToolCallParser {
  /** Feed a raw (already `<status>`-stripped) delta; get forwardable text + any call. */
  push(delta: string): ToolParseResult
  /**
   * Finalise the stream. Returns anything still buffered — a held fence-prefix or
   * an unclosed tool block from a truncated stream — as plain text, so nothing the
   * model wrote is silently lost.
   */
  flush(): string
  /**
   * True while a tool/invoke block is open — its opener has arrived but its closing
   * fence/tag has not. Check it *before* {@link flush} to tell a stream cut off
   * mid tool call (leftover is a never-closable block) from one that ended on benign
   * trailing prose.
   */
  readonly holdingBlock: boolean
  /**
   * The tool name of the block currently held open ({@link holdingBlock}), parsed
   * cheaply from the buffered opener, or null when no block is open yet or its name
   * has not streamed in. Lets the reply loop label a long in-progress write with a
   * live "Writing…" heartbeat while the block streams (it releases no visible text
   * until its closing fence, which would otherwise read as a stall).
   */
  readonly holdingToolName: string | null
}

/**
 * Parse a tool-call body (the JSON between the fences) into `{name, input, error}`.
 * A bad shape degrades to an error string the loop can hand back to the model, so
 * a malformed call becomes a recoverable "that didn't parse" turn, not a wedge.
 */
function parseToolBody(body: string): { name: string | null; input: unknown; error: string | null } {
  const trimmed = body.trim()
  if (!trimmed) return { name: null, input: null, error: 'empty tool call' }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch (err) {
    return { name: null, input: null, error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { name: null, input: null, error: 'tool call must be a JSON object' }
  }
  const rec = obj as Record<string, unknown>
  const name = typeof rec.tool === 'string' && rec.tool.trim() ? rec.tool.trim() : null
  if (!name) return { name: null, input: rec.input ?? null, error: 'missing "tool" field' }
  return { name, input: rec.input ?? {}, error: null }
}

/**
 * Parse a complete tool-call block (fences included) into `{name, input, error}`.
 * Exported for tests and for reuse by callers that already have the whole block.
 */
export function parseToolCall(block: string): { name: string | null; input: unknown; error: string | null } {
  const lines = block.split('\n')
  let end = lines.length
  // Drop the opening fence line (0) and a trailing closing-fence line if present.
  if (end > 1 && /^`{3,}[ \t]*$/.test(lines[end - 1])) end--
  return parseToolBody(lines.slice(1, end).join('\n'))
}

/**
 * True when the char that would follow the marker terminates the info line — a fence
 * carries no payload on the opener line, so a real tool fence is `` ```myto:tool `` then
 * whitespace or a line break. `undefined` (end of buffer) is deliberately NOT a
 * terminator: the next delta could turn `` ```myto:tool `` into `` ```myto:tool_result ``
 * (the RESULT wrapper), so an unterminated marker is left for {@link heldToolPrefix}.
 */
function isMarkerTerminator(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t'
}

/**
 * Index of the first EXACT opening tool fence in `s`, or -1. The fence is matched
 * anywhere on a line — a model may glue it to the prose before it
 * (`…fill the fields reliably.```myto:tool`) instead of breaking a line first — but it
 * must be its OWN three-backtick run terminated right after the marker: both a 4+
 * backtick fence and the `` ```myto:tool_result `` RESULT wrapper contain `` ```myto:tool ``
 * as a substring yet are NOT calls, so a run whose backticks extend past three, or a
 * marker followed by a word char, is rejected.
 */
function findMarker(s: string): number {
  for (let from = 0; ; ) {
    const i = s.indexOf(MARKER, from)
    if (i === -1) return -1
    const prevOk = i === 0 || s[i - 1] !== '`'
    if (prevOk && isMarkerTerminator(s[i + MARKER.length])) return i
    from = i + 1
  }
}

/**
 * Length of the trailing suffix of `s` that could still grow into an opening fence on
 * the next delta and so must be held back rather than shown: a nonempty prefix of
 * {@link MARKER}, or the whole marker whose terminator has not arrived yet (it might
 * become `` ```myto:tool_result ``). The fence is matched ANYWHERE, not only at a line
 * start, because weak models routinely glue it to the prose before it; holding the
 * partial suffix keeps a fence split across deltas at the backtick boundary intact. A
 * run whose backticks continue to the left is a 4+ backtick fence that can never open a
 * call, so it is not held. Anything held is released a tick later once disambiguated,
 * exactly like the status stripper's held `<`.
 */
function heldToolPrefix(s: string): number {
  const max = Math.min(s.length, MARKER.length)
  for (let k = max; k > 0; k--) {
    if (!s.endsWith(MARKER.slice(0, k))) continue
    const before = s.length - k - 1
    // Reject when the leading backticks are the tail of a longer run (a 4+ fence).
    return before < 0 || s[before] !== '`' ? k : 0
  }
  return 0
}

/**
 * From a buffer that starts with an opening tool fence line, extract the complete
 * block once its closing fence has arrived. Returns null while still open.
 */
function extractToolBlock(buf: string): { consumed: number; call: ToolCall } | null {
  const lines = buf.split('\n')
  const openFence = /^(`{3,})/.exec(lines[0])
  const fenceLen = openFence ? openFence[1].length : 3
  // A closing fence is any line that STARTS with a run of >= fenceLen backticks.
  // We deliberately do NOT require the backticks to be alone on the line: weak
  // models routinely glue the next sentence onto the close (```Two files done…),
  // or even the next ```myto:tool fence. Requiring a bare close line made the
  // parser miss those, hold the block open, and swallow every following tool call
  // into one unparseable blob (the plan-stays-0/4 bug). See RC-6 in NOTES.md.
  let closeLine = -1
  let runLen = 0
  for (let k = 1; k < lines.length; k++) {
    const c = /^(`{3,})/.exec(lines[k])
    if (c && c[1].length >= fenceLen) {
      closeLine = k
      runLen = c[1].length
      break
    }
  }
  if (closeLine === -1) return null // not closed yet — hold everything

  // Glued open on the close line: the model wrote the close fence and the NEXT block's
  // ```myto:tool opener with no newline between them, so they merge into one long
  // backtick run (```\n```myto:tool → ``````myto:tool). The greedy match above would eat
  // the whole run as the close and swallow the opener, dropping that next call (e.g. the
  // update_plan the model batched right after a write). When consuming just the open-fence
  // width leaves a ```myto:tool marker at the very start of the surplus (end-of-line counts
  // as its terminator — the real newline was split off — but the ```myto:tool_result
  // wrapper's "_" does NOT), close there and leave the opener for the next scan. RC-6.
  if (runLen > fenceLen) {
    const surplus = lines[closeLine].slice(fenceLen)
    const after = surplus[MARKER.length]
    if (surplus.startsWith(MARKER) && (after === undefined || isMarkerTerminator(after))) {
      runLen = fenceLen
    }
  }

  const body = lines.slice(1, closeLine).join('\n')
  // Byte offset of the start of the closing line, then of the char just past its
  // backtick run. Anything after the run (glued prose or another fence) is left in
  // the buffer for the caller's next scan — only the block itself is consumed.
  let lineStart = 0
  for (let k = 0; k < closeLine; k++) lineStart += lines[k].length + 1
  const runEnd = lineStart + runLen
  const block = buf.slice(0, runEnd)
  // Clean close: only whitespace follows the backticks before the newline/EOF —
  // swallow that trailing newline so we don't leak a blank line into the stream.
  let consumed = runEnd
  let w = runEnd
  while (buf[w] === ' ' || buf[w] === '\t') w++
  if (w >= buf.length || buf[w] === '\n') consumed = buf[w] === '\n' ? w + 1 : w
  return { consumed, call: { block, ...parseToolBody(body) } }
}

/**
 * Remove `| DSML |` token-pollution from a run of text. The pipe-delimited token
 * is so distinctive it never occurs in real prose or code, so stripping it globally
 * is safe; done every push so noise wedged inside a held invoke block is gone by the
 * time its closing tag arrives. The bare-pipe pass runs first so `<|DSML|invoke`
 * collapses cleanly to `<invoke` rather than losing its `<`.
 */
function stripDsmlNoise(s: string): string {
  return s.replace(/<\|\s*DSML\s*\|>/gi, '').replace(/\|\s*DSML\s*\|/gi, '')
}

/**
 * Length of the trailing suffix of `s` that could still grow into a native tool
 * opener — held rather than shown. Checked ONCE at the last `<` (no backward scan,
 * so the function cannot loop): after stripping an optional `antml` namespace
 * prefix, the remainder must either be a proper prefix of an opener name (still
 * typing the word — `<run_`, `<par` mid-`parameter`), a complete name (attributes
 * may still be streaming, awaiting the `>`), or that plus attr text with no `>`
 * yet. A `>` anywhere in the tail means the tag is complete and the main scan's
 * {@link NATIVE_OPEN_RE} decides it — never hold past one. Ordinary markup in
 * prose (`<div …>`) matches no name and flows through.
 *
 * The old version scanned backwards through every `<` and re-derived `i` with
 * `lastIndexOf('<', i - 1)`, which returns 0 forever when i is already 0 — an
 * infinite main-process loop on any buffer like `'<pa'` (mid-word `parameter`
 * matched NO tool-tag prefix and the word-boundary regex needed the whole word).
 * It also leaked `<parameter`'s partials outright, which is how whole
 * `<parameter name="tool">…</parameter>` calls ended up as raw chat text.
 */
function heldInvokePrefix(s: string): number {
  const i = s.lastIndexOf('<')
  if (i === -1) return 0
  const seg = s.slice(i).toLowerCase()
  if (seg.includes('>')) return 0 // complete tag — the main scan decides it
  const stripped = /^<\s*(?:antml[:.]?)?/.exec(seg)
  const word = seg.slice(stripped?.[0].length ?? 1)
  // Hold while the (namespace-stripped) word is still growing toward an opener
  // name, is one, or is one plus streaming attributes not yet closed by '>'. The
  // `antml` namespace prefix itself is also held while still being typed ('<a',
  // '<antm', …) — otherwise the opener leaks piecemeal before it can be recognised.
  const names = ['invoke', 'parameter', ...NATIVE_TOOL_TAGS]
  const typingAntml = word.length > 0 && word.length < 'antml'.length && 'antml'.startsWith(word)
  if (typingAntml || names.some((n) => n.startsWith(word) || word.startsWith(n))) {
    return s.length - i
  }
  return 0
}

/** Coerce a native `<parameter>` value: JSON for object/array literals, else raw. */
function coerceParamValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed // malformed structure — hand the tool the raw text
    }
  }
  return trimmed
}

/**
 * Parse a complete native invoke block into the canonical {@link ToolCall}, or null
 * when it carries no usable tool name (a false positive we release as plain text
 * rather than an errored call — the reply loop aborts the turn on ANY detected call,
 * so emitting an error here would wedge on prose that merely looked like a tag).
 * Exported for tests and callers holding a whole block already.
 */
export function parseInvokeBlock(raw: string): ToolCall | null {
  const cleaned = stripDsmlNoise(raw)
  const open = /<\s*(?:antml[:.]?)?invoke\b([^>]*)>/i.exec(cleaned)
  if (!open) return null
  const nameAttr =
    /\bname\s*=\s*"([^"]*)"/i.exec(open[1]) ?? /\bname\s*=\s*'([^']*)'/i.exec(open[1])
  const name = nameAttr ? nameAttr[1].trim() : ''
  if (!name) return null

  const input: Record<string, unknown> = {}
  const paramRe =
    /<\s*(?:antml[:.]?)?parameter\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\s*(?:antml[:.]?)?parameter\s*>/gi
  for (let m = paramRe.exec(cleaned); m; m = paramRe.exec(cleaned)) {
    input[m[1].trim()] = coerceParamValue(m[2])
  }

  // Fold into the canonical fenced shape so downstream code is format-agnostic.
  return { block: toolCallBlock(name, input), name, input, error: null }
}

/**
 * Build the canonical ```myto:tool block from a name + input. The single source of
 * truth for that wire shape, reused by the native-markup fallback
 * ({@link parseInvokeBlock}) and by the native function-calling path (#15,
 * provider-ipc.ts) — so a call from ANY origin (fenced text, `<invoke>` markup, or a
 * provider's structured tool_calls) records identically in history and renders on
 * the same card.
 */
export function toolCallBlock(name: string, input: unknown): string {
  return `${MARKER}\n${JSON.stringify({ tool: name, input })}\n\`\`\``
}

/**
 * Try `JSON.parse`; return undefined on failure. Shared by the native-tag parsers.
 */
function tryParseJson(s: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(s.trim())
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse a complete NATIVE block (any of the three shapes — `<invoke name=…>`,
 * `<tool_name>{json}</tool_name>`, or the bare `<parameter name="tool">{json}</parameter>`)
 * into the canonical {@link ToolCall}, or null when it carries no usable tool name (a
 * false positive we release as plain text rather than an errored call — the reply loop
 * aborts the turn on ANY detected call, so emitting an error here would wedge on prose
 * that merely looked like a tag). `tag` is the clean tag word NATIVE_OPEN_RE matched.
 * Exported for tests and callers holding a whole block already.
 */
export function parseNativeBlock(raw: string, tag: string): ToolCall | null {
  const cleaned = stripDsmlNoise(raw)
  if (tag === 'invoke') return parseInvokeBlock(raw)

  const openEnd = cleaned.indexOf('>')
  if (openEnd === -1) return null
  const closeIdx = cleaned.toLowerCase().lastIndexOf(`</${tag.toLowerCase()}`)
  if (closeIdx <= openEnd) return null
  const inner = cleaned.slice(openEnd + 1, closeIdx)

  if (tag === 'parameter') {
    // The bare wrapper: its body is the whole call as JSON — `{"tool":"run", …}`.
    // `{"tool":"x","input":{…}}` honours the canonical shape; any other JSON with a
    // string `tool` key takes the remaining keys as the input.
    const obj = tryParseJson(inner)
    if (!obj) return null
    const name = typeof obj.tool === 'string' ? obj.tool.trim() : ''
    if (!name) return null
    const rest = { ...obj }
    delete rest.tool
    const input = 'input' in obj && obj.input && typeof obj.input === 'object' ? obj.input : rest
    return { block: toolCallBlock(name, input), name, input, error: null }
  }

  // A known tool as the tag itself: the name is the tag; the input is either the
  // `<parameter>` children (Anthropic style, without the invoke wrapper) or the
  // JSON body — honouring an explicit {"tool","input"} shape when present.
  let name: string = tag
  let input: unknown
  const params: Record<string, unknown> = {}
  let hasParams = false
  const paramRe =
    /<\s*(?:antml[:.]?)?parameter\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\s*(?:antml[:.]?)?parameter\s*>/gi
  for (let m = paramRe.exec(cleaned); m; m = paramRe.exec(cleaned)) {
    params[m[1].trim()] = coerceParamValue(m[2])
    hasParams = true
  }
  if (hasParams) {
    input = params
  } else {
    const obj = tryParseJson(inner)
    if (obj) {
      if (typeof obj.tool === 'string' && obj.tool.trim() && 'input' in obj) {
        name = (obj.tool as string).trim()
        input = obj.input
      } else {
        input = obj
      }
    } else if (inner.trim()) {
      input = inner.trim()
    }
  }
  return { block: toolCallBlock(name, input), name, input, error: null }
}

/**
 * From a buffer that starts at a native opener for `tag`, extract the whole block
 * once its close tag has arrived. Returns null while still open (hold everything);
 * `call` is null for a tag with no usable tool name, with `raw` carrying the
 * verbatim text to release as prose.
 */
function extractNativeBlock(
  buf: string,
  tag: string
): { consumed: number; call: ToolCall | null; raw: string } | null {
  const close = new RegExp(`</\\s*(?:antml[:.]?)?${tag}\\s*>`, 'i').exec(buf)
  if (!close) return null // not closed yet — hold everything
  const end = close.index + close[0].length
  const raw = buf.slice(0, end)
  let consumed = end
  if (buf[consumed] === '\n') consumed++
  return { consumed, call: parseNativeBlock(raw, tag), raw }
}

/**
 * Index of the first line at/after `from` that starts with a run of at least `min`
 * backticks, or -1. Scans only from `from` forward — the caller keeps `from` at the
 * start of the previous push's partial line, so each byte of a held block is
 * examined O(1) times across the whole stream instead of re-splitting the entire
 * buffer on every delta (the O(n²) that stalled the main process on large
 * `write_file` bodies).
 */
function findCloseLineFrom(buf: string, from: number, min: number): number {
  let pos = from
  for (;;) {
    let n = 0
    while (pos + n < buf.length && buf[pos + n] === '`') n++
    if (n >= min) return pos
    const nl = buf.indexOf('\n', pos)
    if (nl === -1) return -1
    pos = nl + 1
  }
}

export function createToolCallParser(): ToolCallParser {
  // Un-emitted tail: prose about to be released, a partial opening fence or native
  // tag, or a tool block whose closing fence/tag has not arrived.
  let buffer = ''
  let inTool = false
  let inInvoke = false
  // The clean tag word NATIVE_OPEN_RE matched for the open native block ('invoke',
  // 'parameter', or a tool name) — drives the close-tag search and the parser.
  let invokeTag = ''
  // Fenced-block close scanning: the open fence's backtick width (a close must run
  // at least as long) and the buffer index to resume the line scan from — the start
  // of the previous push's still-partial line, which may grow into the close.
  let fenceLen = 3
  let lineScanFrom = 0
  // Native-block close scanning: a sticky global regex for `</tag>` (so lastIndex
  // can resume mid-buffer) and how far the buffer has been scanned without a hit.
  // A block can open MID-buffer (right after a previous call's remainder), so the
  // first search starts at 0; afterwards each push rescans only a small window back
  // from the previous end, so a close straddling the delta boundary is never missed.
  let closeRe: RegExp | null = null
  let invokeScannedTo = 0
  // How far past the last scanned position a `</tag…>` match may START (the pattern
  // can straddle the delta boundary) — the rescan window's width.
  const closeStraddle = (tag: string): number => tag.length + 48

  return {
    push(delta: string): ToolParseResult {
      // Strip token-pollution before appending, so noise wedged inside an invoke
      // block is gone by the time its close tag lands — WITHOUT re-scanning the
      // whole held buffer per delta (O(n²) on a large write_file). The only seam a
      // two-piece noise token could straddle is the append boundary, so the previous
      // push's last few chars are re-stripped with the new delta; a full re-strip
      // runs only when that seam actually contained a '|' (vanishingly rare).
      const added = stripDsmlNoise(delta)
      const prevLen = buffer.length
      // A noise token is at most a handful of chars, so re-stripping the last 48
      // chars of the held buffer together with the new delta catches a token
      // straddling the append boundary; when neither side contains a '|', no noise
      // token can exist there and the delta appends as-is. Small buffers just
      // re-strip whole (bounded, and they are the common case).
      const seamLen = Math.min(48, prevLen)
      const seam = buffer.slice(prevLen - seamLen)
      if (prevLen <= 64) {
        buffer = stripDsmlNoise(buffer + added)
      } else if (added.includes('|') || seam.includes('|')) {
        const stripped = stripDsmlNoise(seam + added)
        buffer = buffer.slice(0, prevLen - seamLen) + stripped
        // Indices into the buffer shifted by whatever the seam strip removed.
        const removed = seamLen + added.length - stripped.length
        if (removed > 0 && lineScanFrom > prevLen - seamLen) {
          lineScanFrom = Math.max(0, lineScanFrom - removed)
        }
      } else {
        buffer += added
      }
      let text = ''

      for (;;) {
        if (!inTool && !inInvoke) {
          // Match the fence anywhere — a model may glue it to the end of a prose line
          // (`…reliably.```myto:tool`) rather than start a fresh line; the prose before
          // it is released as text below. findMarker rejects the ```myto:tool_result
          // wrapper and 4+ backtick fences that merely contain the marker.
          const fenceIdx = findMarker(buffer)
          const invMatch = NATIVE_OPEN_RE.exec(buffer)
          const invIdx = invMatch ? invMatch.index : -1

          if (fenceIdx === -1 && invIdx === -1) {
            // Nothing detected: release safe prose, hold any partial opener tail.
            const hold = Math.max(heldToolPrefix(buffer), heldInvokePrefix(buffer))
            text += buffer.slice(0, buffer.length - hold)
            buffer = buffer.slice(buffer.length - hold)
            return { text, call: null }
          }

          // Enter whichever opener comes first; release the prose before it.
          const useFence = fenceIdx !== -1 && (invIdx === -1 || fenceIdx <= invIdx)
          const idx = useFence ? fenceIdx : invIdx
          text += buffer.slice(0, idx)
          buffer = buffer.slice(idx)
          if (useFence) {
            inTool = true
            // The open fence's width gates how long a close-line backtick run must
            // be; the close scan starts over the opener line itself.
            fenceLen = /^(`{3,})/.exec(buffer)?.[1].length ?? 3
            lineScanFrom = 0
          } else {
            inInvoke = true
            invokeTag = (invMatch?.[1] ?? 'invoke').toLowerCase()
            closeRe = new RegExp(`</\\s*(?:antml[:.]?)?${invokeTag}\\s*>`, 'gi')
            invokeScannedTo = 0
          }
        }

        if (inTool) {
          // Cheap incremental check first: has any line grown into a close fence?
          // Rescanning only from the previous partial line keeps a multi-KB block
          // O(n) across the whole stream. Once a candidate exists, the exact
          // extraction (glued-open handling, consumption width) runs once, whole.
          const closeAt = findCloseLineFrom(buffer, lineScanFrom, fenceLen)
          if (closeAt === -1) {
            lineScanFrom = buffer.lastIndexOf('\n') + 1
            return { text, call: null } // still open — hold the block
          }
          const found = extractToolBlock(buffer)
          if (!found) {
            // The only way the exact extractor disagrees with the cheap scan: the
            // candidate is the opener line itself (it starts with the fence but is
            // never a close). Skip past it so the scan can never re-latch, then
            // keep holding.
            const nl = buffer.indexOf('\n', closeAt)
            lineScanFrom = nl === -1 ? buffer.length : nl + 1
            return { text, call: null }
          }
          buffer = buffer.slice(found.consumed)
          inTool = false
          // A single delta rarely carries two calls, but the loop aborts on the
          // first, so returning it here is enough; the caller stops the stream.
          return { text, call: found.call }
        }

        // inInvoke: native markup — <invoke>, a tool-name tag, or the bare
        // <parameter name="tool"> wrapper. Windowed close search: a match may
        // straddle the delta boundary, so resume from just before where the last
        // push ended rather than re-scanning the whole held block per delta.
        const from = Math.max(0, Math.min(invokeScannedTo, buffer.length) - closeStraddle(invokeTag))
        closeRe!.lastIndex = from
        const closeHit = closeRe!.exec(buffer)
        if (!closeHit) {
          invokeScannedTo = buffer.length
          return { text, call: null } // still open — hold the block
        }
        const found = extractNativeBlock(buffer, invokeTag)
        if (!found) return { text, call: null } // still open — hold the block
        buffer = buffer.slice(found.consumed)
        inInvoke = false
        closeRe = null
        if (!found.call) {
          // No tool name — a false positive. Release verbatim so a stray `<invoke`
          // in prose can never wedge the reply loop, and keep scanning.
          text += found.raw
          continue
        }
        return { text, call: found.call }
      }
    },

    flush(): string {
      const rest = buffer
      buffer = ''
      inTool = false
      inInvoke = false
      invokeTag = ''
      closeRe = null
      lineScanFrom = 0
      fenceLen = 3
      return rest
    },
    get holdingBlock(): boolean {
      return inTool || inInvoke
    },
    get holdingToolName(): string | null {
      if (inInvoke) {
        const attr =
          /<\s*(?:antml[:.]?)?invoke\b[^>]*?\bname\s*=\s*["']([^"']+)["']/i.exec(buffer)
        if (attr) return attr[1].trim()
        // A tool-name tag IS the name: <run_code… → run_code. The bare parameter
        // wrapper names nothing until its JSON body lands.
        const tag = /^<\s*(?:antml[:.]?)?([a-z_][a-z0-9_]*)/i.exec(buffer)
        if (tag && tag[1] !== 'parameter') return tag[1]
        const json = /"tool"\s*:\s*"([^"]+)"/.exec(buffer)
        if (json) return json[1].trim()
        return null
      }
      if (inTool) {
        const m = /"tool"\s*:\s*"([^"]+)"/.exec(buffer)
        return m ? m[1].trim() : null
      }
      return null
    }
  }
}

/**
 * The shortest backtick fence that can wrap `text` without a run of backticks
 * inside it closing the block early — same rule as the renderer's `fenceFor`. A
 * tool result is arbitrary web content that may itself contain ```` ``` ````
 * fences, so the result wrapper widens to stay a single parseable block.
 */
export function fenceFor(text: string): string {
  let max = 0
  for (const run of text.matchAll(/`+/g)) max = Math.max(max, run[0].length)
  return '`'.repeat(Math.max(3, max + 1))
}

/**
 * Wrap a tool result as a fenced block the reply carries and the renderer coalesces
 * onto its call card. Padded with blank lines so it never fuses with adjacent prose
 * or the call block's own fence.
 */
export function toolResultBlock(name: string, result: string): string {
  const fence = fenceFor(result)
  return `\n\n${fence}myto:tool_result ${name}\n${result}\n${fence}\n\n`
}
