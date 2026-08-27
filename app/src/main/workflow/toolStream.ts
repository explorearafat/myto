/**
 * Streaming extractor for `sylor-tool` blocks.
 *
 * The model emits side-effecting operations as fenced blocks in its normal text
 * stream:
 *
 *     ```sylor-tool
 *     { "tool": "write_file", "path": "src/foo.ts", "content": "…" }
 *     ```
 *
 * This parser demultiplexes that stream as it arrives: prose flows through to
 * the chat as `delta`s, while bytes inside a tool block are suppressed (so raw
 * JSON never flashes in the UI) and surfaced as structured {@link ParsedTool}s
 * once the block closes.
 *
 * Robustness notes:
 *  - Fence markers can be split across chunks, so a possible partial-marker tail
 *    is held back rather than emitted prematurely.
 *  - The close fence is a raw newline followed by ``` on its own line. Because a
 *    tool payload is JSON — whose string values encode newlines as `\n`, never
 *    raw bytes — a triple-backtick *inside* a file's `content` cannot be mistaken
 *    for the closing fence.
 *  - Malformed or unterminated blocks are dropped (with a warning), never thrown.
 */
import { hasRole } from './orchestrator/roles'

const OPEN_FENCE = '```sylor-tool'

/** A tool operation parsed from a block, before the engine enriches it. */
export type ParsedTool =
  | { tool: 'write_file'; path: string; content: string }
  | { tool: 'edit_file'; path: string; oldString: string; newString: string; replaceAll: boolean }
  | { tool: 'read_file'; path: string; offset?: number; limit?: number }
  | { tool: 'list_files'; path: string }
  | { tool: 'search_files'; query: string; path: string; glob?: string }
  | { tool: 'run_command'; command: string }
  | { tool: 'remember'; note: string }
  | { tool: 'mcp_call'; server: string; name: string; arguments: Record<string, unknown> }
  | { tool: 'use_skill'; name: string }
  | { tool: 'spawn_agent'; role: string; task: string }

/**
 * A positive integer field, or undefined when absent/invalid. Used for the
 * optional `offset`/`limit` line window on read_file: a garbage value is dropped
 * (falling back to the default window) rather than failing the whole block, since
 * the read itself is still perfectly well-defined without it.
 */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  return n > 0 ? n : undefined
}

/**
 * How many leading chars of `buffer` are safe to emit as prose without risking
 * splitting a (possibly still-incomplete) occurrence of `marker`. If a full
 * marker is present, everything before it is safe; otherwise we hold back the
 * longest suffix that could be the start of the marker.
 */
function safeEmitLength(buffer: string, marker: string): number {
  const idx = buffer.indexOf(marker)
  if (idx !== -1) return idx
  const maxHold = Math.min(marker.length - 1, buffer.length)
  for (let hold = maxHold; hold > 0; hold--) {
    if (buffer.endsWith(marker.slice(0, hold))) return buffer.length - hold
  }
  return buffer.length
}

/**
 * Locates the closing fence inside an open tool block. Returns the index where
 * the JSON body ends and where the stream resumes after the fence line, or null
 * if no complete close fence is present yet.
 */
function findClose(buf: string): { jsonEnd: number; after: number } | null {
  let from = 0
  for (;;) {
    const nl = buf.indexOf('\n```', from)
    if (nl === -1) return null
    const afterTicks = nl + 4 // index just past the three backticks
    if (buf[afterTicks] === '`') {
      from = nl + 1 // more than three backticks; not our fence
      continue
    }
    // Tolerate trailing spaces/tabs after the fence before the line break, so a
    // "```  \n" close is recognized here exactly as flush() would salvage it.
    let ws = afterTicks
    while (buf[ws] === ' ' || buf[ws] === '\t') ws++
    const next = buf[ws]
    if (next === undefined) return null // fence may still grow — wait for more
    if (next === '\r') {
      // Need the char after '\r' to tell CRLF (consume both) from a lone CR
      // (consume one). If it hasn't arrived, wait — committing now would leak the
      // pending '\n' into the following prose.
      if (buf[ws + 1] === undefined) return null
      return { jsonEnd: nl, after: buf[ws + 1] === '\n' ? ws + 2 : ws + 1 }
    }
    if (next === '\n') {
      return { jsonEnd: nl, after: ws + 1 }
    }
    // ``` followed by other text on the same line — not a clean close.
    from = nl + 1
  }
}

/** Validates a raw block body into a {@link ParsedTool}, or null if invalid. */
export function parseToolBlock(raw: string): ParsedTool | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null

  const rec = obj as Record<string, unknown>
  if (rec.tool === 'write_file') {
    if (typeof rec.path === 'string' && rec.path.trim() && typeof rec.content === 'string') {
      return { tool: 'write_file', path: rec.path, content: rec.content }
    }
    return null
  }
  if (rec.tool === 'edit_file') {
    // A surgical replacement: `old_string` must appear in the file, and swapping in
    // `new_string` produces the edit. `new_string` may be '' (a deletion), but the
    // two must differ — a no-op edit is a malformed block, not a valid write.
    if (
      typeof rec.path === 'string' &&
      rec.path.trim() &&
      typeof rec.old_string === 'string' &&
      rec.old_string.length > 0 &&
      typeof rec.new_string === 'string' &&
      rec.old_string !== rec.new_string
    ) {
      return {
        tool: 'edit_file',
        path: rec.path,
        oldString: rec.old_string,
        newString: rec.new_string,
        replaceAll: rec.replace_all === true
      }
    }
    return null
  }
  if (rec.tool === 'read_file') {
    if (typeof rec.path === 'string' && rec.path.trim()) {
      return {
        tool: 'read_file',
        path: rec.path,
        offset: positiveInt(rec.offset),
        limit: positiveInt(rec.limit)
      }
    }
    return null
  }
  if (rec.tool === 'list_files') {
    // `path` is optional here — a bare list_files block means "the project root".
    const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path : '.'
    return { tool: 'list_files', path }
  }
  if (rec.tool === 'search_files') {
    if (typeof rec.query === 'string' && rec.query.length > 0) {
      const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path : '.'
      const glob = typeof rec.glob === 'string' && rec.glob.trim() ? rec.glob : undefined
      return { tool: 'search_files', query: rec.query, path, glob }
    }
    return null
  }
  if (rec.tool === 'run_command') {
    if (typeof rec.command === 'string' && rec.command.trim()) {
      return { tool: 'run_command', command: rec.command }
    }
    return null
  }
  if (rec.tool === 'remember') {
    if (typeof rec.note === 'string' && rec.note.trim()) {
      return { tool: 'remember', note: rec.note }
    }
    return null
  }
  if (rec.tool === 'mcp_call') {
    if (typeof rec.server === 'string' && rec.server.trim() && typeof rec.name === 'string' && rec.name.trim()) {
      // `arguments` is optional; default to an empty object. Anything that isn't a
      // plain object (array, string, null) is treated as "no arguments" rather than
      // rejected, so a sloppy-but-harmless call still reaches the server.
      const args =
        typeof rec.arguments === 'object' && rec.arguments !== null && !Array.isArray(rec.arguments)
          ? (rec.arguments as Record<string, unknown>)
          : {}
      return { tool: 'mcp_call', server: rec.server, name: rec.name, arguments: args }
    }
    return null
  }
  if (rec.tool === 'use_skill') {
    if (typeof rec.name === 'string' && rec.name.trim()) {
      return { tool: 'use_skill', name: rec.name }
    }
    return null
  }
  if (rec.tool === 'spawn_agent') {
    // Any role in the extensible registry can be delegated to (planner / builder /
    // reviewer plus the domain specialists) — adding a specialist is a registry
    // entry, not a change here. `lead` is the run itself and is never spawnable.
    // Subagents cannot spawn further subagents — the engine simply never teaches
    // them this block (nesting depth 1).
    const role = rec.role
    if (
      typeof role === 'string' &&
      role !== 'lead' &&
      hasRole(role) &&
      typeof rec.task === 'string' &&
      rec.task.trim()
    ) {
      return { tool: 'spawn_agent', role, task: rec.task }
    }
    return null
  }
  return null
}

/**
 * Stateful, incremental parser. Feed it `delta`s; it returns the prose to render
 * and accumulates parsed tool ops in {@link tools}. Call {@link flush} at the end
 * of the stream to release any held-back prose and salvage a trailing block.
 */
export class ToolStreamParser {
  /** Tool ops discovered so far, in stream order. */
  readonly tools: ParsedTool[] = []

  private buffer = '' // prose not yet emitted (may hold a partial-marker tail)
  private toolBuffer = '' // body accumulated while inside a block
  private inside = false

  /** Feeds a delta; returns the prose safe to render now (possibly empty). */
  push(delta: string): string {
    if (this.inside) this.toolBuffer += delta
    else this.buffer += delta

    let out = ''
    for (;;) {
      if (!this.inside) {
        const idx = this.buffer.indexOf(OPEN_FENCE)
        if (idx === -1) {
          const safe = safeEmitLength(this.buffer, OPEN_FENCE)
          out += this.buffer.slice(0, safe)
          this.buffer = this.buffer.slice(safe)
          break
        }
        out += this.buffer.slice(0, idx)
        let rest = this.buffer.slice(idx + OPEN_FENCE.length)
        // Drop a single newline right after the open fence.
        if (rest.startsWith('\r\n')) rest = rest.slice(2)
        else if (rest.startsWith('\n')) rest = rest.slice(1)
        this.buffer = ''
        this.toolBuffer = rest
        this.inside = true
      } else {
        const close = findClose(this.toolBuffer)
        if (!close) break
        this.commit(this.toolBuffer.slice(0, close.jsonEnd))
        this.buffer = this.toolBuffer.slice(close.after)
        this.toolBuffer = ''
        this.inside = false
      }
    }
    return out
  }

  /** Ends the stream: emits held prose and salvages any trailing block. */
  flush(): string {
    if (this.inside) {
      // Salvage a block whose close fence lacked a trailing newline.
      const raw = this.toolBuffer.replace(/\n```[ \t]*$/, '')
      this.commit(raw)
      this.toolBuffer = ''
      this.inside = false
      return ''
    }
    const out = this.buffer
    this.buffer = ''
    return out
  }

  private commit(raw: string): void {
    const parsed = parseToolBlock(raw)
    if (parsed) {
      this.tools.push(parsed)
    } else {
      console.warn('[sylor] dropping malformed sylor-tool block')
    }
  }
}
