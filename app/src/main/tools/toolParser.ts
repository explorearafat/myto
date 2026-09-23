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

export function createToolCallParser(): ToolCallParser {
  // Un-emitted tail: prose about to be released, a partial opening fence, or a
  // tool block whose closing fence has not arrived.
  let buffer = ''
  let inTool = false

  return {
    push(delta: string): ToolParseResult {
      buffer += delta
      let text = ''

      for (;;) {
        if (!inTool) {
          const idx = lineStartIndexOf(buffer, MARKER)
          if (idx === -1) {
            const hold = heldToolPrefix(buffer)
            text += buffer.slice(0, buffer.length - hold)
            buffer = buffer.slice(buffer.length - hold)
            return { text, call: null }
          }
          // Release the prose before the fence; keep the fence onward.
          text += buffer.slice(0, idx)
          buffer = buffer.slice(idx)
          inTool = true
        }

        const found = extractToolBlock(buffer)
        if (!found) return { text, call: null } // still open — hold the block
        buffer = buffer.slice(found.consumed)
        inTool = false
        // A single delta rarely carries two calls, but the loop aborts on the
        // first, so returning it here is enough; the caller stops the stream.
        return { text, call: found.call }
      }
    },

    flush(): string {
      const rest = buffer
      buffer = ''
      inTool = false
      return rest
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
