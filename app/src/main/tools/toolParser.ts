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
 * emit their *native* tool-call markup straight into the token stream:
 *
 *     <invoke name="run_command">
 *       <parameter name="command">npm run build</parameter>
 *     </invoke>
 *
 * It arrives dressed up in ways the fenced parser never sees: an `antml:` / `antml`
 * namespace prefix on every tag, and stray `| DSML |` token-pollution wedged in
 * around the angle brackets. Left alone this leaks into the chat as raw text and the
 * call never runs. We detect it, strip the noise, and fold it into the SAME
 * {@link ToolCall} shape (with a synthesised canonical `` ```myto:tool `` block) so
 * everything downstream — the reply loop, the renderer's cards — is none the wiser.
 */
/** Matches the START of a native invoke tag (namespace-tolerant), anywhere in a line. */
const INVOKE_OPEN = /<\s*(?:antml[:.]?)?invoke\b/i
/** Matches a native invoke CLOSE tag (namespace-tolerant). */
const INVOKE_CLOSE = /<\/\s*(?:antml[:.]?)?invoke\s*>/i
/** The literal openers whose partial tails must be held back mid-stream. */
const INVOKE_OPENERS = ['<invoke', '<invoke']

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

/** Index of the first line in `s` that begins with `marker`, or -1. */
function lineStartIndexOf(s: string, marker: string): number {
  if (s.startsWith(marker)) return 0
  let from = 0
  for (;;) {
    const nl = s.indexOf('\n', from)
    if (nl === -1) return -1
    if (s.startsWith(marker, nl + 1)) return nl + 1
    from = nl + 1
  }
}

/**
 * Length of the trailing suffix of `s` that is a nonempty proper prefix of
 * {@link MARKER} sitting at a line start — i.e. text that could still grow into an
 * opening fence on the next delta, so it must be held back rather than shown. A
 * closing ```` ``` ```` fence of some other block matches too and is simply
 * released a tick later, exactly like the status stripper's held `<`.
 */
function heldToolPrefix(s: string): number {
  const nl = s.lastIndexOf('\n')
  const lastLine = nl === -1 ? s : s.slice(nl + 1)
  if (lastLine.length > 0 && lastLine.length < MARKER.length && MARKER.startsWith(lastLine)) {
    return lastLine.length
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
  let closeLine = -1
  for (let k = 1; k < lines.length; k++) {
    const c = /^(`{3,})[ \t]*$/.exec(lines[k])
    if (c && c[1].length >= fenceLen) {
      closeLine = k
      break
    }
  }
  if (closeLine === -1) return null // not closed yet — hold everything

  const block = lines.slice(0, closeLine + 1).join('\n')
  const body = lines.slice(1, closeLine).join('\n')
  // Skip the block and, when present, the single '\n' separating it from the rest.
  let consumed = block.length
  if (buf[consumed] === '\n') consumed++
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
 * Length of the trailing suffix of `s` that is a nonempty proper prefix of a native
 * invoke opener (`<invoke` / `<invoke`) — text that could still grow into a real
 * tag next delta, so it is held rather than shown. A lone trailing `<` is held one
 * tick and released the moment the next char rules the tag out, exactly like the
 * fenced held-prefix and the status stripper's held `<`.
 */
function heldInvokePrefix(s: string): number {
  const lower = s.toLowerCase()
  let best = 0
  for (const opener of INVOKE_OPENERS) {
    const maxK = Math.min(s.length, opener.length - 1)
    for (let k = maxK; k > best; k--) {
      if (lower.endsWith(opener.slice(0, k))) {
        best = k
        break
      }
    }
  }
  return best
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
 * From a buffer that starts at a native invoke opener, extract the whole block once
 * its `</invoke>` has arrived. Returns null while still open (hold everything);
 * `call` is null for a tag with no tool name, with `raw` carrying the verbatim text
 * to release as prose.
 */
function extractInvokeBlock(buf: string): { consumed: number; call: ToolCall | null; raw: string } | null {
  const close = INVOKE_CLOSE.exec(buf)
  if (!close) return null // not closed yet — hold everything
  const end = close.index + close[0].length
  const raw = buf.slice(0, end)
  let consumed = end
  if (buf[consumed] === '\n') consumed++
  return { consumed, call: parseInvokeBlock(raw), raw }
}

export function createToolCallParser(): ToolCallParser {
  // Un-emitted tail: prose about to be released, a partial opening fence or invoke
  // tag, or a tool block whose closing fence/tag has not arrived.
  let buffer = ''
  let inTool = false
  let inInvoke = false

  return {
    push(delta: string): ToolParseResult {
      // Strip token-pollution across the whole held buffer every push, so noise
      // wedged inside an invoke block is cleaned by the time its close tag lands.
      buffer = stripDsmlNoise(buffer + delta)
      let text = ''

      for (;;) {
        if (!inTool && !inInvoke) {
          const fenceIdx = lineStartIndexOf(buffer, MARKER)
          const invMatch = INVOKE_OPEN.exec(buffer)
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
          if (useFence) inTool = true
          else inInvoke = true
        }

        if (inTool) {
          const found = extractToolBlock(buffer)
          if (!found) return { text, call: null } // still open — hold the block
          buffer = buffer.slice(found.consumed)
          inTool = false
          // A single delta rarely carries two calls, but the loop aborts on the
          // first, so returning it here is enough; the caller stops the stream.
          return { text, call: found.call }
        }

        // inInvoke: native `<invoke>` markup.
        const found = extractInvokeBlock(buffer)
        if (!found) return { text, call: null } // still open — hold the block
        buffer = buffer.slice(found.consumed)
        inInvoke = false
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
      return rest
    },
    get holdingBlock(): boolean {
      return inTool || inInvoke
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
