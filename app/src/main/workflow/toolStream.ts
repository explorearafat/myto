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
 *
 * Stop-at-action: with a {@link ToolStreamParserOptions.stopAfter} predicate, the
 * parser closes itself the instant a matching block completes — the rest of the
 * completion is discarded rather than parsed. That is what makes the agent act one
 * step at a time (think → act → observe → think) instead of emitting eight writes
 * blind. The stop lives here, not in the engine, because a single delta can carry
 * prose from *before* and *after* a block: only the parser can return the leading
 * prose while dropping the trailing prose (which describes work that will never
 * happen).
 */
import { hasRole } from './orchestrator/roles'

const OPEN_FENCE = '```sylor-tool'

/** A tool operation parsed from a block, before the engine enriches it. */
export type ParsedTool =
  | { tool: 'write_file'; path: string; content: string; purpose?: string }
  | {
      tool: 'edit_file'
      path: string
      /**
       * One or more exact-string replacements applied to the file IN ORDER, so a
       * single block can carry every change to one file (read it once, then edit it
       * once). The single-edit wire form is normalized into a one-element array.
       */
      edits: Array<{ oldString: string; newString: string; replaceAll: boolean }>
      purpose?: string
    }
  | { tool: 'read_file'; path: string; offset?: number; limit?: number; purpose?: string }
  | { tool: 'list_files'; path: string; purpose?: string }
  | { tool: 'search_files'; query: string; path: string; glob?: string; before?: number; after?: number; context?: number; multiline?: boolean; mode?: 'content' | 'files' | 'count'; purpose?: string }
  | { tool: 'find_files'; glob: string; path: string; purpose?: string }
  | { tool: 'run_command'; command: string }
  | { tool: 'web_fetch'; url: string }
  | { tool: 'web_search'; query: string }
  | { tool: 'install_plugin'; source: string; scope: 'global' | 'project' }
  | { tool: 'remember'; note: string }
  | { tool: 'remember_user'; note: string }
  | { tool: 'mcp_call'; server: string; name: string; arguments: Record<string, unknown> }
  | { tool: 'use_skill'; name: string }
  | { tool: 'spawn_agent'; role: string; task: string; isolation?: 'worktree'; background?: boolean }
  | {
      tool: 'preview_inspect'
      action:
        | 'snapshot'
        | 'screenshot'
        | 'inspect'
        | 'console_logs'
        | 'network'
        | 'click'
        | 'fill'
        | 'resize'
        | 'eval'
        | 'navigate'
        | 'server_logs'
      selector?: string
      styles?: string[]
      value?: string
      level?: 'all' | 'error' | 'warn'
      filter?: 'all' | 'failed'
      preset?: 'mobile' | 'tablet' | 'desktop'
      width?: number
      height?: number
      expression?: string
      url?: string
    }
  | {
      tool: 'browse'
      action: 'read' | 'navigate' | 'click' | 'type' | 'scroll' | 'console' | 'network' | 'inspect'
      url?: string
      target?: string
      text?: string
      submit?: boolean
      direction?: 'up' | 'down'
      visual?: boolean
      selector?: string
      styles?: string[]
      level?: 'all' | 'error' | 'warn'
      filter?: 'all' | 'failed'
    }
  | { tool: 'diagnostics'; scope?: 'all' | 'typescript' | 'eslint'; files?: string[] }
  | {
      tool: 'update_todos'
      todos: { text: string; status: 'pending' | 'in_progress' | 'completed' }[]
    }
  | { tool: 'ask_user'; question: string; header?: string; options?: string[] }
  | { tool: 'flag_followup'; title: string; note?: string; files?: string[] }

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

/** Longest `purpose` a one-line card subtitle can carry without wrapping away. */
const MAX_PURPOSE = 120

/** Longest a single TODO line may be; longer text is clipped, never rejected. */
const MAX_TODO_TEXT = 200

/** Longest a clarifying question may be; longer text is clipped, never rejected. */
const MAX_QUESTION_TEXT = 500

/** Longest a single answer option (chip label) may be; longer text is clipped. */
const MAX_OPTION_TEXT = 120

/** Longest the question's short header/topic label may be; longer text is clipped. */
const MAX_QUESTION_HEADER = 40

/** How many answer options a single question may offer; extras beyond this are dropped. */
const MAX_QUESTION_OPTIONS = 6

/** Longest a flagged follow-up's one-line title may be; longer text is clipped. */
const MAX_FOLLOWUP_TITLE = 90

/** Longest a follow-up's explanatory note may be; longer text is clipped. */
const MAX_FOLLOWUP_NOTE = 400

/** How many files a single follow-up may name; extras beyond this are dropped. */
const MAX_FOLLOWUP_FILES = 6

/**
 * The optional `purpose`: on a write, one short phrase saying what the file is for;
 * on a read/list/search, what the model is trying to find out by looking. Shown
 * under a write card, so a transcript still explains why each file exists after the
 * prose has scrolled away. On a read it is context for the model only — the user's
 * reading status shows just `Reading <filename>`, so purpose there is optional.
 * Absent, blank or non-string means no subtitle — never a rejected block, because
 * what an op is *for* must not be able to stop it from happening.
 */
function purposeOf(rec: Record<string, unknown>): { purpose?: string } {
  if (typeof rec.purpose !== 'string') return {}
  const text = rec.purpose.trim().replace(/\s+/g, ' ')
  return text ? { purpose: text.slice(0, MAX_PURPOSE) } : {}
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
      return { tool: 'write_file', path: rec.path, content: rec.content, ...purposeOf(rec) }
    }
    return null
  }
  if (rec.tool === 'edit_file') {
    // A surgical replacement: `old_string` must appear in the file, and swapping in
    // `new_string` produces the edit. `new_string` may be '' (a deletion), but the
    // two must differ — a no-op edit is a malformed block, not a valid write.
    //
    // Two wire forms, both normalized to the `edits` array so the engine has one
    // shape to run: a single `old_string`/`new_string`, or an `edits: [...]` list of
    // them applied in order (every change to one file in ONE action). A list entry
    // is validated exactly like the single form; invalid entries are dropped, and a
    // block that ends up with no valid edit is malformed.
    if (typeof rec.path !== 'string' || !rec.path.trim()) return null
    const one = (
      o: unknown,
      n: unknown,
      all: unknown
    ): { oldString: string; newString: string; replaceAll: boolean } | null =>
      typeof o === 'string' && o.length > 0 && typeof n === 'string' && o !== n
        ? { oldString: o, newString: n, replaceAll: all === true }
        : null
    const edits: Array<{ oldString: string; newString: string; replaceAll: boolean }> = []
    if (Array.isArray(rec.edits)) {
      for (const raw of rec.edits) {
        if (typeof raw !== 'object' || raw === null) continue
        const e = raw as Record<string, unknown>
        const parsed = one(e.old_string, e.new_string, e.replace_all)
        if (parsed) edits.push(parsed)
      }
    } else {
      const parsed = one(rec.old_string, rec.new_string, rec.replace_all)
      if (parsed) edits.push(parsed)
    }
    if (edits.length === 0) return null
    return { tool: 'edit_file', path: rec.path, edits, ...purposeOf(rec) }
  }
  if (rec.tool === 'read_file') {
    if (typeof rec.path === 'string' && rec.path.trim()) {
      return {
        tool: 'read_file',
        path: rec.path,
        offset: positiveInt(rec.offset),
        limit: positiveInt(rec.limit),
        ...purposeOf(rec)
      }
    }
    return null
  }
  if (rec.tool === 'list_files') {
    // `path` is optional here — a bare list_files block means "the project root".
    const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path : '.'
    return { tool: 'list_files', path, ...purposeOf(rec) }
  }
  if (rec.tool === 'search_files') {
    if (typeof rec.query === 'string' && rec.query.length > 0) {
      const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path : '.'
      const glob = typeof rec.glob === 'string' && rec.glob.trim() ? rec.glob : undefined
      // Context/multiline/mode are all optional refinements: a garbage value is
      // dropped (falling back to the plain per-line content search) rather than
      // failing the whole block, since the grep is well-defined without them.
      const mode =
        rec.mode === 'files' || rec.mode === 'count' || rec.mode === 'content' ? rec.mode : undefined
      return {
        tool: 'search_files',
        query: rec.query,
        path,
        glob,
        before: positiveInt(rec.before),
        after: positiveInt(rec.after),
        context: positiveInt(rec.context),
        multiline: rec.multiline === true ? true : undefined,
        mode,
        ...purposeOf(rec)
      }
    }
    return null
  }
  if (rec.tool === 'find_files') {
    // `glob` is the query here (the name/path pattern); `path` optionally narrows
    // the search root, defaulting to the whole project.
    if (typeof rec.glob === 'string' && rec.glob.trim()) {
      const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path : '.'
      return { tool: 'find_files', glob: rec.glob, path, ...purposeOf(rec) }
    }
    return null
  }
  if (rec.tool === 'run_command') {
    if (typeof rec.command === 'string' && rec.command.trim()) {
      return { tool: 'run_command', command: rec.command }
    }
    return null
  }
  if (rec.tool === 'web_fetch') {
    // Accept an http/https URL; other schemes and non-strings are rejected here so
    // a malformed block never reaches the fetcher.
    if (typeof rec.url === 'string' && /^https?:\/\/\S+$/i.test(rec.url.trim())) {
      return { tool: 'web_fetch', url: rec.url.trim() }
    }
    return null
  }
  if (rec.tool === 'web_search') {
    // A non-empty natural-language query; the search endpoint itself is fixed, so
    // there is no URL to validate — just a usable query string.
    if (typeof rec.query === 'string' && rec.query.trim()) {
      return { tool: 'web_search', query: rec.query.trim() }
    }
    return null
  }
  if (rec.tool === 'install_plugin') {
    // `source` is the repo/URL/folder to install; validated for shape only here
    // (normalizePluginSource does the real parsing downstream). `scope` defaults to
    // 'global' — a plugin usually applies everywhere — and only 'project' overrides.
    if (typeof rec.source === 'string' && rec.source.trim()) {
      const scope = rec.scope === 'project' ? 'project' : 'global'
      return { tool: 'install_plugin', source: rec.source.trim(), scope }
    }
    return null
  }
  if (rec.tool === 'remember') {
    if (typeof rec.note === 'string' && rec.note.trim()) {
      return { tool: 'remember', note: rec.note }
    }
    return null
  }
  if (rec.tool === 'remember_user') {
    if (typeof rec.note === 'string' && rec.note.trim()) {
      return { tool: 'remember_user', note: rec.note }
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
      // Two optional execution modifiers, validated defensively so a bad value is
      // dropped rather than failing the whole delegation:
      //  - isolation: 'worktree' runs the agent in a private git worktree so its
      //    writes/commands can't collide with the lead's or a sibling's.
      //  - background: true makes the spawn non-blocking — the lead keeps working
      //    and receives the report when the agent finishes.
      const isolation = rec.isolation === 'worktree' ? 'worktree' : undefined
      const background = rec.background === true ? true : undefined
      return { tool: 'spawn_agent', role, task: rec.task, isolation, background }
    }
    return null
  }
  if (rec.tool === 'preview_inspect') {
    // Verify a running preview. `action` is the required discriminator; the rest
    // are per-action refinements validated defensively so a malformed field is
    // dropped rather than failing the whole block.
    const ACTIONS = [
      'snapshot',
      'screenshot',
      'inspect',
      'console_logs',
      'network',
      'click',
      'fill',
      'resize',
      'eval',
      'navigate',
      'server_logs'
    ] as const
    const action = ACTIONS.find((a) => a === rec.action)
    if (!action) return null
    const selector =
      typeof rec.selector === 'string' && rec.selector.trim() ? rec.selector.trim() : undefined
    // inspect/click/fill act on a specific element — no selector, no action.
    if ((action === 'inspect' || action === 'click' || action === 'fill') && !selector) return null
    // fill must carry the text to type (empty string is a valid "clear the field").
    if (action === 'fill' && typeof rec.value !== 'string') return null
    // eval is nothing without the code to run; a blank expression would evaluate to
    // `undefined` and read as a mysteriously empty result.
    const expression =
      typeof rec.expression === 'string' && rec.expression.trim() ? rec.expression : undefined
    if (action === 'eval' && !expression) return null
    // navigate takes a URL; omitting it means "reload where we are", which is a
    // real request, so an absent url is allowed here (the executor decides).
    const url = typeof rec.url === 'string' && rec.url.trim() ? rec.url.trim() : undefined
    const styles =
      Array.isArray(rec.styles) && rec.styles.every((s) => typeof s === 'string' && s.trim())
        ? (rec.styles as string[])
        : undefined
    const level =
      rec.level === 'error' || rec.level === 'warn' || rec.level === 'all' ? rec.level : undefined
    const filter = rec.filter === 'failed' || rec.filter === 'all' ? rec.filter : undefined
    const preset =
      rec.preset === 'mobile' || rec.preset === 'tablet' || rec.preset === 'desktop'
        ? rec.preset
        : undefined
    return {
      tool: 'preview_inspect',
      action,
      selector,
      styles,
      value: action === 'fill' ? (rec.value as string) : undefined,
      level,
      filter,
      preset,
      width: positiveInt(rec.width),
      height: positiveInt(rec.height),
      expression,
      url
    }
  }
  if (rec.tool === 'browse') {
    // Drive a real web page. `action` is the required discriminator; the per-action
    // fields below are the minimum each one cannot work without, so a malformed
    // block is rejected here rather than reaching a browser.
    const ACTIONS = [
      'read',
      'navigate',
      'click',
      'type',
      'scroll',
      'console',
      'network',
      'inspect'
    ] as const
    const action = ACTIONS.find((a) => a === rec.action)
    if (!action) return null
    const url = typeof rec.url === 'string' && rec.url.trim() ? rec.url.trim() : undefined
    const target =
      typeof rec.target === 'string' && rec.target.trim() ? rec.target.trim() : undefined
    // `inspect` takes a CSS selector; accept `target` as an alias, since the model
    // has just spent the whole page brief using `target` to point at things. Any
    // other action has no use for one, so a stray `selector` is dropped rather
    // than shown in the step's description.
    const selector =
      action !== 'inspect'
        ? undefined
        : typeof rec.selector === 'string' && rec.selector.trim()
          ? rec.selector.trim()
          : target
    // navigate needs somewhere to go; click/type need something to act on.
    if (action === 'navigate' && !url) return null
    if ((action === 'click' || action === 'type') && !target) return null
    if (action === 'inspect' && !selector) return null
    // type must carry the text ('' is a valid "clear the field").
    if (action === 'type' && typeof rec.text !== 'string') return null
    const direction = rec.direction === 'up' ? 'up' : rec.direction === 'down' ? 'down' : undefined
    // Extra style properties are advisory: keep the usable ones rather than losing
    // the whole list to one bad entry.
    const wantedStyles =
      action === 'inspect' && Array.isArray(rec.styles)
        ? rec.styles.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : []
    const styles = wantedStyles.length > 0 ? wantedStyles : undefined
    const level =
      action === 'console' && (rec.level === 'error' || rec.level === 'warn' || rec.level === 'all')
        ? rec.level
        : undefined
    const filter =
      action === 'network' && (rec.filter === 'failed' || rec.filter === 'all')
        ? rec.filter
        : undefined
    return {
      tool: 'browse',
      action,
      url,
      target,
      text: action === 'type' ? (rec.text as string) : undefined,
      submit: rec.submit === true ? true : undefined,
      direction: action === 'scroll' ? (direction ?? 'down') : undefined,
      visual: action === 'read' && rec.visual === true ? true : undefined,
      selector,
      styles,
      level,
      filter
    }
  }
  if (rec.tool === 'diagnostics') {
    // Read the project's checkers. Both fields are optional: with neither, every
    // installed checker runs over the whole project, which is the common case and
    // must not be rejected. `scope` is left undefined when unstated so the runner
    // applies its own default (defaulting here would duplicate that rule), and
    // `paths` is accepted as an alias for `files` — the read tools spell it `path`,
    // so the model reaches for it.
    const scope =
      rec.scope === 'typescript' || rec.scope === 'eslint' || rec.scope === 'all'
        ? rec.scope
        : undefined
    const raw = Array.isArray(rec.files) ? rec.files : Array.isArray(rec.paths) ? rec.paths : []
    // Keep the usable paths rather than losing the whole narrowing to one bad entry.
    const files = raw.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    return { tool: 'diagnostics', scope, files: files.length > 0 ? files : undefined }
  }
  if (rec.tool === 'update_todos') {
    // The model's flat checklist for the turn. `todos` must be an array; each item
    // needs non-empty `text`, and `status` falls back to 'pending' for anything
    // that isn't one of the three known states. Malformed items are dropped rather
    // than failing the block — but a non-empty input that yields nothing usable is
    // rejected (a garbage block shouldn't silently clear the list). An empty array
    // is a valid, deliberate "clear the checklist".
    if (!Array.isArray(rec.todos)) return null
    const STATUSES = ['pending', 'in_progress', 'completed'] as const
    const todos = rec.todos.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const r = item as Record<string, unknown>
      const text = typeof r.text === 'string' ? r.text.trim().replace(/\s+/g, ' ') : ''
      if (!text) return []
      const status = STATUSES.find((s) => s === r.status) ?? 'pending'
      return [{ text: text.slice(0, MAX_TODO_TEXT), status }]
    })
    if (rec.todos.length > 0 && todos.length === 0) return null
    return { tool: 'update_todos', todos }
  }
  if (rec.tool === 'ask_user') {
    // A clarifying question the model wants answered before it continues. `question`
    // is required and non-empty (a blank question is nothing to answer). `options`,
    // when given, are the suggested answer chips: filtered to non-empty strings,
    // trimmed/capped, and dropped entirely if none survive — a free-text answer is
    // always allowed, so bad options degrade to "no chips", never a rejected block.
    // `header` is an optional short topic label shown on the prompt.
    const question =
      typeof rec.question === 'string' ? rec.question.trim().replace(/\s+/g, ' ') : ''
    if (!question) return null
    const header =
      typeof rec.header === 'string' && rec.header.trim()
        ? rec.header.trim().replace(/\s+/g, ' ').slice(0, MAX_QUESTION_HEADER)
        : undefined
    const options = Array.isArray(rec.options)
      ? rec.options
          .flatMap((o) => {
            const text = typeof o === 'string' ? o.trim().replace(/\s+/g, ' ') : ''
            return text ? [text.slice(0, MAX_OPTION_TEXT)] : []
          })
          .slice(0, MAX_QUESTION_OPTIONS)
      : []
    return {
      tool: 'ask_user',
      question: question.slice(0, MAX_QUESTION_TEXT),
      ...(header ? { header } : {}),
      ...(options.length > 0 ? { options } : {})
    }
  }
  if (rec.tool === 'flag_followup') {
    // An out-of-scope issue the model noticed and is deliberately NOT doing now.
    // `title` is the whole tool: a one-line imperative the user can act on, so a
    // blank one is nothing to flag and the block is rejected. `note` (why it
    // matters) and `files` (where it lives) are optional colour — bad values are
    // dropped rather than failing the block, because what a follow-up *explains*
    // must not be able to stop it from being recorded.
    const title = typeof rec.title === 'string' ? rec.title.trim().replace(/\s+/g, ' ') : ''
    if (!title) return null
    const note = typeof rec.note === 'string' ? rec.note.trim().replace(/\s+/g, ' ') : ''
    const raw = Array.isArray(rec.files) ? rec.files : Array.isArray(rec.paths) ? rec.paths : []
    const files = raw
      .flatMap((f) => {
        const text = typeof f === 'string' ? f.trim() : ''
        return text ? [text] : []
      })
      .slice(0, MAX_FOLLOWUP_FILES)
    return {
      tool: 'flag_followup',
      title: title.slice(0, MAX_FOLLOWUP_TITLE),
      ...(note ? { note: note.slice(0, MAX_FOLLOWUP_NOTE) } : {}),
      ...(files.length > 0 ? { files } : {})
    }
  }
  return null
}

/**
 * Stateful, incremental parser. Feed it `delta`s; it returns the prose to render
 * and accumulates parsed tool ops in {@link tools}. Call {@link flush} at the end
 * of the stream to release any held-back prose and salvage a trailing block.
 */
export interface ToolStreamParserOptions {
  /**
   * Closes the parser as soon as a committed block matches — used to enforce one
   * action per model message. Everything after that block's close fence is
   * discarded: later blocks are never parsed and trailing prose is never emitted.
   * Omit for the classic "parse the whole completion" behaviour.
   */
  stopAfter?: (tool: ParsedTool) => boolean
}

export class ToolStreamParser {
  /** Tool ops discovered so far, in stream order. */
  readonly tools: ParsedTool[] = []

  /** True once {@link ToolStreamParserOptions.stopAfter} matched; the parser is closed. */
  stopped = false

  /**
   * Chars of the fed stream that were actually parsed. Equals everything fed
   * until a stop, at which point it freezes just past the triggering block's
   * close fence — so the caller can truncate the raw assistant text to exactly
   * what it acted on.
   */
  consumed = 0

  private buffer = '' // prose not yet emitted (may hold a partial-marker tail)
  private toolBuffer = '' // body accumulated while inside a block
  private inside = false
  private fed = 0 // total chars pushed, for the `consumed` boundary
  private readonly stopAfter?: (tool: ParsedTool) => boolean

  constructor(options: ToolStreamParserOptions = {}) {
    this.stopAfter = options.stopAfter
  }

  /** Feeds a delta; returns the prose safe to render now (possibly empty). */
  push(delta: string): string {
    if (this.stopped) return ''
    this.fed += delta.length
    this.consumed = this.fed
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
        const committed = this.commit(this.toolBuffer.slice(0, close.jsonEnd))
        const rest = this.toolBuffer.slice(close.after)
        this.toolBuffer = ''
        this.inside = false
        if (committed && this.stopAfter?.(committed)) {
          // Freeze at the close fence and drop the tail: `rest` is a suffix of the
          // fed stream, so `fed - rest.length` is the index just past the fence.
          this.stopped = true
          this.consumed = this.fed - rest.length
          this.buffer = ''
          break
        }
        this.buffer = rest
      }
    }
    return out
  }

  /** Ends the stream: emits held prose and salvages any trailing block. */
  flush(): string {
    if (this.stopped) return ''
    if (this.inside) {
      // Salvage a block whose close fence lacked a trailing newline.
      const raw = this.toolBuffer.replace(/\n```[ \t]*$/, '')
      const committed = this.commit(raw)
      this.toolBuffer = ''
      this.inside = false
      if (committed && this.stopAfter?.(committed)) this.stopped = true
      return ''
    }
    const out = this.buffer
    this.buffer = ''
    return out
  }

  /** Parses and records a block body; returns the tool, or null if malformed. */
  private commit(raw: string): ParsedTool | null {
    const parsed = parseToolBlock(raw)
    if (parsed) {
      this.tools.push(parsed)
    } else {
      console.warn('[sylor] dropping malformed sylor-tool block')
    }
    return parsed
  }
}
