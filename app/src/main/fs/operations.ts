import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { contextManager, IGNORED_DIRS } from '../context/manager'
import { fullAccessEnabled } from '../settings'

/**
 * Sandbox violation: a requested path resolved outside the project root. This is
 * the security boundary for Phase 4 — the engine may only touch files under the
 * active project, never arbitrary locations on disk.
 */
export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path escapes the project root: ${requested}`)
    this.name = 'PathEscapeError'
  }
}

/**
 * Resolves a project-relative (or absolute-within-root) path to an absolute path,
 * guaranteeing the result stays inside the project root. Throws
 * {@link PathEscapeError} for any `..` traversal, absolute path, or symlink-style
 * escape that lands outside the sandbox.
 *
 * Two gates: (1) a cheap lexical check on the normalized path, then (2) a
 * `realpath` check that resolves symlinks along the existing portion of the
 * path — so a symlink *inside* the root that points outside it cannot be used to
 * escape. Because the target may not exist yet (a create), the realpath gate is
 * applied to the nearest existing ancestor.
 */
export function resolveSafe(requested: string): string {
  const root = contextManager.getRoot()
  // Reject absolute inputs unless they're already within the root.
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)

  // Full-PC access (opt-in): the project sandbox is the boundary this function
  // exists to enforce, so when the user has switched it off we resolve the path
  // and return it WITHOUT the two escape gates below — any location on the
  // machine is reachable. A project-relative input is still resolved against the
  // root (so ordinary "src/x.ts" keeps working); an absolute input goes wherever
  // it points. The switch is read fresh each call, so turning it back off
  // re-confines immediately with no restart.
  if (fullAccessEnabled()) return abs

  // Gate 1 — lexical: `rel` starting with '..' (or an absolute path on another
  // drive) means the normalized path escapes the root.
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError(requested)
  }

  // Gate 2 — physical: resolve symlinks. `abs` may not exist yet, so walk up to
  // the nearest existing ancestor and verify its real path is still inside the
  // root's real path. A symlink inside the root pointing elsewhere fails here.
  const realRoot = realpathSyncSafe(root)
  const realAbs = realpathNearest(abs)
  const realRel = relative(realRoot, realAbs)
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new PathEscapeError(requested)
  }

  return abs
}

/** realpath that tolerates a not-yet-existing root (returns the input as-is). */
function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Real (symlink-resolved) path of the nearest existing ancestor of `abs`,
 * re-joined with the non-existent trailing segments. Lets us sandbox-check a
 * path whose final components don't exist yet (a file we're about to create).
 */
function realpathNearest(abs: string): string {
  let dir = abs
  const trailing: string[] = []
  for (;;) {
    if (existsSync(dir)) return resolve(realpathSync(dir), ...trailing.reverse())
    const parent = dirname(dir)
    if (parent === dir) return abs // reached the filesystem root without a hit
    trailing.push(basename(dir))
    dir = parent
  }
}

/** Reads a project file (sandbox-checked). Throws on escape or read failure. */
export function readProjectFile(relPath: string): string {
  const abs = resolveSafe(relPath)
  return readFileSync(abs, 'utf-8')
}

/**
 * Writes `content` to a project file (sandbox-checked), creating parent
 * directories as needed. Throws {@link PathEscapeError} on escape.
 */
export function writeProjectFile(relPath: string, content: string): void {
  const abs = resolveSafe(relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

/** A prospective write, resolved for diff display before anything touches disk. */
export interface WriteProposal {
  /** Whether the target file already exists (edit vs create). */
  exists: boolean
  /** Current contents, or '' when the file is new. */
  oldContent: string
  /** The proposed new contents (unchanged input, echoed for convenience). */
  newContent: string
}

/**
 * Prepares a write for approval: reads the current contents (if any) so the UI
 * can render an old-vs-new diff. Sandbox-checked but does NOT write. Throws
 * {@link PathEscapeError} on escape.
 */
export function proposeWrite(relPath: string, newContent: string): WriteProposal {
  const abs = resolveSafe(relPath)
  const exists = existsSync(abs)
  const oldContent = exists ? readFileSync(abs, 'utf-8') : ''
  return { exists, oldContent, newContent }
}

// ── Project inspection (read_file / list_files / search_files) ─────────────
//
// These are what let the agent work on code it didn't just write: open the real
// file, list what's actually there, grep for a symbol. Every one is
// sandbox-checked through resolveSafe and reads from disk fresh — deliberately
// NOT through ContextManager, whose caches would hand back a pre-edit copy and
// make a read-after-write loop lie.

/**
 * Hard ceiling on the text one inspection feeds back to the model (≈20k tokens).
 * A read that would exceed it stops at the last whole line that fits, says where it
 * stopped, and is flagged `truncated` — so a 2 MB bundle can't blow the context
 * window.
 *
 * Sized to hold a REAL source file whole. It used to be 24k, which clipped an
 * ordinary 1,700-line component — and a model handed two thirds of a file comes
 * back for the rest, then for a narrower window, then for another: the repeated-read
 * loop `workflow/gather.ts` exists to end. One big file in full is cheaper than four
 * partial looks at it, and far more likely to produce a correct edit. Compaction's
 * own budget (`MAX_CONTEXT_CHARS`) is sized above this so one whole-file read cannot
 * by itself force a fold every step.
 */
const MAX_READ_CHARS = 80_000

/**
 * Default line window for a read_file with no explicit `limit` — which, since
 * `planReadWindow` drops model-supplied limits, is effectively every read. High
 * enough that {@link MAX_READ_CHARS} is the binding constraint for anything but a
 * file of very short lines, so "how much did I get" has one answer, not two.
 */
const DEFAULT_READ_LINES = 4_000

/** Bounds for a directory listing and a project search. */
const MAX_LIST_ENTRIES = 400
const MAX_SEARCH_MATCHES = 60
const MAX_SEARCH_FILES = 3_000
const MAX_SEARCH_DEPTH = 12
/** Longest list a `find_files` glob returns before it's clipped. */
const MAX_FIND_MATCHES = 200
/** Longest single matched line echoed back (a minified bundle line is useless). */
const MAX_MATCH_LINE_CHARS = 300

/** The bounded text an inspection produces, plus a one-line summary for the UI. */
export interface ReadOutcome {
  /** The file text / listing / match lines. */
  output: string
  /** True when a cap clipped the result. */
  truncated: boolean
  /** Human one-liner for the tool card ('240 lines', '8 matches in 3 files'). */
  summary: string
}

/**
 * Clips `text` to {@link MAX_READ_CHARS}, reporting whether it had to. Used for
 * output that is a LIST — a directory listing, search matches, a command's stdout —
 * where the last entry being cut short costs nothing. A file read goes through
 * {@link joinUnderCap} instead, which cuts on a line boundary and says where.
 */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_READ_CHARS) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_READ_CHARS)}\n… (output clipped)`, truncated: true }
}

/**
 * Joins numbered lines under {@link MAX_READ_CHARS}, cutting at a LINE boundary and
 * reporting how many made it.
 *
 * Cutting mid-line would hand the model a half-written statement it might then quote
 * back as an `old_string`; and clipping the joined string left the caller unable to
 * say which line the text actually stopped at, so its summary claimed the whole
 * window it had asked for. A single line longer than the entire budget — a minified
 * bundle on one line — is kept, hard-cut, rather than returning nothing at all.
 */
function joinUnderCap(lines: string[]): { text: string; kept: number } {
  let used = 0
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + (i > 0 ? 1 : 0) // +1 for the joining newline
    if (used + cost > MAX_READ_CHARS) {
      if (i === 0) return { text: lines[0].slice(0, MAX_READ_CHARS), kept: 1 }
      return { text: lines.slice(0, i).join('\n'), kept: i }
    }
    used += cost
  }
  return { text: lines.join('\n'), kept: lines.length }
}

/** Heuristic binary check: a NUL byte in the first 8 KB means "not source". */
function looksBinary(text: string): boolean {
  return text.slice(0, 8_192).includes('\0')
}

/** Splits into lines without a trailing empty entry for a final newline. */
function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Reads a project file as numbered lines, optionally windowed by a 1-based
 * `offset` and a `limit`. Numbering is what makes the result *citable* — the
 * model can say "line 412" and the user can follow along — but the numbers are
 * display only and must never be pasted back into an edit's `old_string`.
 *
 * The window is almost always the whole file: `planReadWindow` refuses a guessed
 * `offset`/`limit` on a file this run has not read yet, because a keyhole view is
 * never enough to edit against and buys a second read (see `workflow/gather.ts`).
 * So the interesting case here is the one where the file genuinely does not fit:
 * the text stops at a LINE boundary, the summary says which line it stopped at
 * rather than which line was asked for, and the tail names the exact `offset` to
 * continue from — the only legitimate reason to read one path twice.
 *
 * Throws {@link PathEscapeError} on a sandbox escape, or the underlying fs error
 * when the file is missing/unreadable; the caller turns that into a failed result.
 */
export function readFileSlice(relPath: string, offset?: number, limit?: number): ReadOutcome {
  const raw = readProjectFile(relPath)
  if (looksBinary(raw)) {
    return { output: '(binary file — not shown)', truncated: false, summary: 'binary file' }
  }
  const lines = toLines(raw)
  const start = Math.max(0, (offset ?? 1) - 1)
  const end = Math.min(lines.length, start + (limit ?? DEFAULT_READ_LINES))
  const window = lines.slice(start, end)
  const width = String(end).length
  const numbered = window.map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`)

  const { text, kept } = joinUnderCap(numbered)
  // What actually made it out, as a 1-based line number — NOT what was asked for.
  const shownEnd = start + kept
  const more = shownEnd < lines.length
  const windowed = start > 0 || more
  const summary = windowed
    ? `lines ${start + 1}–${shownEnd} of ${lines.length}`
    : `${lines.length} line${lines.length === 1 ? '' : 's'}`
  // A window that doesn't reach the end counts as truncated, so the model always
  // knows there is more file left — and is told precisely how to get it, instead of
  // being invited to guess a "narrower range" (which is what produced keyholes).
  const tail = more
    ? `\n… (stopped at line ${shownEnd} of ${lines.length}${
        kept < window.length ? ' — the rest would not fit in one read' : ''
      }; to continue, read \`${relPath}\` again with "offset": ${shownEnd + 1})`
    : ''
  return { output: text ? text + tail : '(empty file)', truncated: more, summary }
}

/** Human-readable byte size for a caption ('245 KB', '1.4 MB'). */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Image extensions a vision model can read, mapped to their MIME type. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/**
 * Ceiling on an image we'll hand to the model. Anthropic rejects images past ~5 MB,
 * and sending one would fail the whole turn — so we refuse it here with a message
 * the model can act on, rather than letting the request blow up downstream.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** A {@link ReadOutcome} that may carry an attached image for a vision model. */
export interface MediaOutcome extends ReadOutcome {
  media?: { kind: 'image'; mediaType: string; dataBase64: string }
}

/**
 * If `relPath` names something a model can VIEW rather than read as text, returns
 * a media outcome; otherwise returns null so the caller falls back to
 * {@link readFileSlice}. Images (PNG/JPEG/GIF/WebP) come back as base64 bytes
 * (capped at {@link MAX_IMAGE_BYTES}) plus a text caption. A PDF is recognized but
 * not rendered — an OpenAI-compatible image channel can't carry one — so it
 * returns a caption explaining that, with no bytes, instead of failing. Sandbox-
 * checked; throws the underlying fs error when the file is missing/unreadable.
 */
export function readMediaFile(relPath: string): MediaOutcome | null {
  const ext = extname(relPath).toLowerCase()
  const mediaType = IMAGE_MEDIA_TYPES[ext]
  if (mediaType) {
    const abs = resolveSafe(relPath)
    const bytes = readFileSync(abs)
    const name = basename(relPath)
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return {
        output: `(${name} is a ${fmtBytes(bytes.byteLength)} image — too large to view; the limit is ${fmtBytes(MAX_IMAGE_BYTES)}. Ask for a smaller copy or a cropped region.)`,
        truncated: false,
        summary: 'image too large'
      }
    }
    return {
      output: `${name} — ${ext.slice(1).toUpperCase()} image, ${fmtBytes(bytes.byteLength)} (shown below).`,
      truncated: false,
      summary: `image · ${fmtBytes(bytes.byteLength)}`,
      media: { kind: 'image', mediaType, dataBase64: bytes.toString('base64') }
    }
  }
  if (ext === '.pdf') {
    const abs = resolveSafe(relPath)
    const size = statSync(abs).size
    return {
      output: `(${basename(relPath)} is a PDF, ${fmtBytes(size)}. Sylor can view images directly (PNG/JPEG/GIF/WebP) but does not render PDF pages yet — ask the user for the relevant text, or a screenshot/exported image of the page you need.)`,
      truncated: false,
      summary: 'pdf (not viewable)'
    }
  }
  return null
}

/**
 * Lists one directory: subdirectories first (with a trailing `/`), then files
 * with their byte sizes. One level only — the model asks again to go deeper,
 * which keeps each result small and the exploration deliberate.
 */
export function listDirectory(relPath: string): ReadOutcome {
  const abs = resolveSafe(relPath || '.')
  const entries = readdirSync(abs, { withFileTypes: true })
  const dirs: string[] = []
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skip build/vendor noise so a listing shows the project, not its artifacts.
      if (IGNORED_DIRS.has(entry.name)) continue
      dirs.push(`${entry.name}/`)
      continue
    }
    let size = 0
    try {
      size = statSync(join(abs, entry.name)).size
    } catch {
      // Unreadable (permission, race) — still list it, just without a size.
    }
    files.push(`${entry.name}  (${size} B)`)
  }
  dirs.sort()
  files.sort()

  const all = [...dirs, ...files]
  const capped = all.slice(0, MAX_LIST_ENTRIES)
  const overflow = all.length - capped.length
  const body = capped.length > 0 ? capped.join('\n') : '(empty directory)'
  const { text, truncated } = clip(overflow > 0 ? `${body}\n… (+${overflow} more)` : body)
  return {
    output: text,
    truncated: truncated || overflow > 0,
    summary: `${dirs.length} folder${dirs.length === 1 ? '' : 's'}, ${files.length} file${files.length === 1 ? '' : 's'}`
  }
}

/**
 * Translates a shell-style glob into an anchored regex. Supports `*` (within one
 * path segment), `**` (across segments), `?`, and `{a,b}` alternatives. A pattern
 * with no `/` is matched against the basename, so `*.ts` finds TypeScript
 * anywhere — the behaviour anyone who has used ripgrep expects.
 */
function globToRegExp(pattern: string): { re: RegExp; basenameOnly: boolean } {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
        // Swallow the slash after `**` so `**/x` also matches a bare `x`.
        if (pattern[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') out += '[^/]'
    else if (ch === '{') out += '(?:'
    else if (ch === '}') out += ')'
    else if (ch === ',') out += '|'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return { re: new RegExp(`^${out}$`), basenameOnly: !pattern.includes('/') }
}

/** Compiles `query` as a regex, falling back to a literal match if it won't parse. */
function toSearchRegExp(query: string, multiline: boolean): RegExp {
  // `g` is needed to walk every multiline match; `s` lets `.` cross newlines and
  // `m` anchors ^/$ per line, which is what "match across lines" should mean.
  const flags = multiline ? 'gms' : ''
  try {
    return new RegExp(query, flags)
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }
}

/** Refinements a caller can layer onto {@link searchProject}. */
export interface SearchOptions {
  /** Lines of trailing context per hit (grep -A). */
  after?: number
  /** Lines of leading context per hit (grep -B). */
  before?: number
  /** Context on BOTH sides (grep -C); fills in before/after when they're unset. */
  context?: number
  /** Match a pattern that spans lines (the hit's START line is what's reported). */
  multiline?: boolean
  /** `content` (matching lines, default), `files` (paths only), `count` (tallies). */
  mode?: 'content' | 'files' | 'count'
}

/**
 * Finds the 0-based line indices in `lines` that `re` matches. For a per-line
 * search that's every line the regex tests true against; for a multiline search
 * the regex is walked over the whole text and each match maps to the line its
 * start offset falls on (so a match spanning several lines reports one hit, at
 * its beginning — the same line ripgrep prints for a `-U` match).
 */
function matchingLineIndices(text: string, lines: string[], re: RegExp, multiline: boolean): number[] {
  if (!multiline) {
    const idxs: number[] = []
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) idxs.push(i)
    return idxs
  }
  // Precompute line-start offsets so a match index maps to a line in O(log n).
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const lineOf = (offset: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const idxs: number[] = []
  let seen = -1
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const line = lineOf(m.index)
    if (line !== seen) {
      idxs.push(line)
      seen = line
    }
    // A zero-width match would loop forever — nudge lastIndex past it.
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return idxs
}

/**
 * Greps the project for `query` (a regex, or a literal when it doesn't compile),
 * returning `path:line: text` hits grouped by file. Walks from `relPath` fresh on
 * every call, skipping {@link IGNORED_DIRS} and binaries, bounded by
 * {@link MAX_SEARCH_FILES} files and {@link MAX_SEARCH_MATCHES} hits.
 *
 * `opts` layers on ripgrep-style refinements: `before`/`after`/`context` print
 * surrounding lines (context lines use a `path-line-` separator, matches a
 * `path:line:` one, and non-adjacent groups are divided by `--`); `multiline`
 * matches patterns that span lines; and `mode` switches the whole result to a
 * bare file list (`files`) or per-file match tallies (`count`). With no options
 * the output is byte-identical to the plain per-line content search.
 */
export function searchProject(
  query: string,
  relPath = '.',
  glob?: string,
  opts: SearchOptions = {}
): ReadOutcome {
  const root = resolveSafe(relPath || '.')
  const projectRoot = contextManager.getRoot()
  const multiline = opts.multiline === true
  const re = toSearchRegExp(query, multiline)
  const globMatch = glob ? globToRegExp(glob) : null
  const mode = opts.mode ?? 'content'
  const before = Math.max(0, opts.before ?? opts.context ?? 0)
  const after = Math.max(0, opts.after ?? opts.context ?? 0)

  const hits: string[] = []
  const fileList: string[] = []
  const counts: Array<{ rel: string; n: number }> = []
  let matchCount = 0
  let fileHitCount = 0
  let scanned = 0
  let capped = false

  const walk = (dir: string, depth: number): void => {
    if (capped || depth > MAX_SEARCH_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip silently, same as the context walker
    }
    for (const entry of entries) {
      if (capped) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (++scanned > MAX_SEARCH_FILES) {
        capped = true
        return
      }
      const rel = relative(projectRoot, full).split(sep).join('/')
      if (globMatch && !globMatch.re.test(globMatch.basenameOnly ? entry.name : rel)) continue

      let text: string
      try {
        text = readFileSync(full, 'utf-8')
      } catch {
        continue
      }
      if (looksBinary(text)) continue

      const lines = toLines(text)
      if (multiline) re.lastIndex = 0
      const matchIdxs = matchingLineIndices(text, lines, re, multiline)
      if (matchIdxs.length === 0) continue
      fileHitCount++

      if (mode === 'files') {
        if (fileList.length >= MAX_FIND_MATCHES) {
          capped = true
          return
        }
        fileList.push(rel)
        continue
      }
      if (mode === 'count') {
        matchCount += matchIdxs.length
        counts.push({ rel, n: matchIdxs.length })
        continue
      }

      // content mode — emit the matched lines, with optional surrounding context.
      const matchSet = new Set(matchIdxs)
      // Merge each match's [i-before, i+after] window into non-overlapping ranges.
      const ranges: Array<[number, number]> = []
      for (const i of matchIdxs) {
        const lo = Math.max(0, i - before)
        const hi = Math.min(lines.length - 1, i + after)
        const last = ranges[ranges.length - 1]
        if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
        else ranges.push([lo, hi])
      }
      for (let r = 0; r < ranges.length; r++) {
        if (matchCount >= MAX_SEARCH_MATCHES) {
          capped = true
          break
        }
        if ((before > 0 || after > 0) && (hits.length > 0 || r > 0)) hits.push('--')
        const [lo, hi] = ranges[r]
        for (let ln = lo; ln <= hi; ln++) {
          const isMatch = matchSet.has(ln)
          if (isMatch) {
            if (matchCount >= MAX_SEARCH_MATCHES) {
              capped = true
              break
            }
            matchCount++
          }
          const raw = lines[ln]
          const shown = raw.length > MAX_MATCH_LINE_CHARS ? `${raw.slice(0, MAX_MATCH_LINE_CHARS)}…` : raw
          // Match lines use `:`; context lines use `-` — grep's convention.
          hits.push(`${rel}:${ln + 1}${isMatch ? ': ' : '- '}${shown.trim()}`)
        }
      }
      if (capped) return
    }
  }
  walk(root, 0)

  if (mode === 'files') {
    fileList.sort()
    const body =
      fileList.length > 0
        ? fileList.join('\n') + (capped ? `\n… (stopped at ${MAX_FIND_MATCHES} files)` : '')
        : `No files contain ${query}`
    const { text, truncated } = clip(body)
    return {
      output: text,
      truncated: truncated || capped,
      summary: fileList.length === 0 ? 'no files' : `${fileList.length} file${fileList.length === 1 ? '' : 's'}`
    }
  }
  if (mode === 'count') {
    const body =
      counts.length > 0
        ? counts.map((c) => `${c.rel}:${c.n}`).join('\n') + (capped ? '\n… (search capped)' : '')
        : `No matches for ${query}`
    const { text, truncated } = clip(body)
    return {
      output: text,
      truncated: truncated || capped,
      summary:
        matchCount === 0
          ? 'no matches'
          : `${matchCount} match${matchCount === 1 ? '' : 'es'} in ${fileHitCount} file${fileHitCount === 1 ? '' : 's'}`
    }
  }

  const body =
    hits.length > 0
      ? hits.join('\n') + (capped ? `\n… (stopped at ${MAX_SEARCH_MATCHES} matches)` : '')
      : `No matches for ${query}`
  const { text, truncated } = clip(body)
  return {
    output: text,
    truncated: truncated || capped,
    summary:
      matchCount === 0
        ? 'no matches'
        : `${matchCount} match${matchCount === 1 ? '' : 'es'} in ${fileHitCount} file${fileHitCount === 1 ? '' : 's'}`
  }
}

// ── File discovery by name (find_files) ────────────────────────────────────

/**
 * Enumerates project files whose path matches a shell glob — the analogue of a
 * ripgrep `--files -g` / Claude Code's Glob tool. Where {@link searchProject}
 * greps file *contents*, this finds files by *name/path*, which is how you locate
 * "every test file", "the config", or "all the components" without knowing a
 * symbol to search for.
 *
 * The glob follows {@link globToRegExp}: `*` within a segment, `**` across
 * segments, `?`, and `{a,b}`. A pattern with no `/` matches the basename anywhere
 * (so `*.ts` finds TypeScript at any depth); a pattern with a `/` matches the
 * project-relative POSIX path. Walks fresh from `relPath`, skipping
 * {@link IGNORED_DIRS} and hidden directories exactly like the search walker, and
 * is bounded by {@link MAX_SEARCH_FILES} scanned and {@link MAX_FIND_MATCHES}
 * returned. Results are sorted for stable output. Throws {@link PathEscapeError}
 * on a sandbox escape.
 */
export function findFiles(pattern: string, relPath = '.'): ReadOutcome {
  const root = resolveSafe(relPath || '.')
  const projectRoot = contextManager.getRoot()
  const { re, basenameOnly } = globToRegExp(pattern)

  const matches: string[] = []
  let scanned = 0
  let capped = false

  const walk = (dir: string, depth: number): void => {
    if (capped || depth > MAX_SEARCH_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip silently, same as the search walker
    }
    for (const entry of entries) {
      if (capped) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (++scanned > MAX_SEARCH_FILES) {
        capped = true
        return
      }
      const rel = relative(projectRoot, full).split(sep).join('/')
      if (re.test(basenameOnly ? entry.name : rel)) {
        if (matches.length >= MAX_FIND_MATCHES) {
          capped = true
          return
        }
        matches.push(rel)
      }
    }
  }
  walk(root, 0)
  matches.sort()

  const body =
    matches.length > 0
      ? matches.join('\n') + (capped ? `\n… (stopped at ${MAX_FIND_MATCHES} files)` : '')
      : `No files match ${pattern}`
  const { text, truncated } = clip(body)
  return {
    output: text,
    truncated: truncated || capped,
    summary:
      matches.length === 0
        ? 'no files'
        : `${matches.length} file${matches.length === 1 ? '' : 's'}`
  }
}

// ── Surgical edits (edit_file) ─────────────────────────────────────────────

/**
 * An `edit_file` whose target text couldn't be located unambiguously. Thrown
 * rather than guessed at: a near-miss replacement in the wrong place is far worse
 * than a refusal the model can see and correct. The message is written FOR the
 * model — it names the likely mistake so the retry is informed.
 */
export class EditMatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditMatchError'
  }
}

/**
 * Applies ONE exact-string replacement to an in-memory string and returns the
 * result — the pure core shared by {@link applyEdit} and {@link applyEdits}. Nothing
 * is read or written here; `relPath` is passed only so the thrown messages name the
 * file the model was aiming at.
 *
 * `oldString` must occur EXACTLY once unless `replaceAll` is set. Zero occurrences
 * or (without the flag) several both throw {@link EditMatchError}.
 */
function applyOneEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  relPath: string
): string {
  // Count occurrences by scanning, not split(), so an empty needle can't loop.
  let count = 0
  for (let i = content.indexOf(oldString); i !== -1; i = content.indexOf(oldString, i + oldString.length)) {
    count++
    if (count > 1 && !replaceAll) break
  }

  if (count === 0) {
    throw new EditMatchError(
      `old_string was not found in ${relPath}. It must match the file byte for byte — ` +
        `including indentation, and WITHOUT the line numbers read_file prints for display. ` +
        `Read the file again and copy the exact text you want to replace.`
    )
  }
  if (count > 1 && !replaceAll) {
    throw new EditMatchError(
      `old_string appears more than once in ${relPath}, so the edit is ambiguous. ` +
        `Include enough surrounding lines to make it unique, or set "replace_all": true ` +
        `to change every occurrence.`
    )
  }

  // Spliced by index rather than String.replace: a replacement containing `$&`,
  // `$1`, or `` $` `` would otherwise be reinterpreted as a substitution pattern
  // and silently corrupt the file. split/join is likewise pattern-free.
  const at = content.indexOf(oldString)
  return replaceAll
    ? content.split(oldString).join(newString)
    : content.slice(0, at) + newString + content.slice(at + oldString.length)
}

/**
 * Resolves an exact-string replacement against a project file's current contents,
 * returning old and new text for the approval diff. Pure: nothing is written here
 * — the caller stages it as a normal `write_file` proposal, so a surgical edit
 * still shows the user a diff and still passes the permission gate.
 *
 * `oldString` must occur EXACTLY once unless `replaceAll` is set. Zero occurrences
 * or (without the flag) several both throw {@link EditMatchError}.
 */
export function applyEdit(
  relPath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): { oldContent: string; newContent: string } {
  const abs = resolveSafe(relPath)
  if (!existsSync(abs)) {
    throw new EditMatchError(
      `${relPath} does not exist, so there is nothing to edit. Use write_file to create it.`
    )
  }
  const oldContent = readFileSync(abs, 'utf-8')
  return { oldContent, newContent: applyOneEdit(oldContent, oldString, newString, replaceAll, relPath) }
}

/**
 * Applies a SEQUENCE of exact-string replacements to one file, reading it once and
 * folding each edit over the evolving text, so every change to a file lands in a
 * single `write_file` proposal (one diff, one approval, one action) instead of a
 * separate round-trip per edit. Each edit is matched against the result of the ones
 * before it — so a later edit may target text an earlier edit introduced — and any
 * miss throws {@link EditMatchError} naming the file, leaving nothing written.
 */
export function applyEdits(
  relPath: string,
  edits: ReadonlyArray<{ oldString: string; newString: string; replaceAll: boolean }>
): { oldContent: string; newContent: string } {
  const abs = resolveSafe(relPath)
  if (!existsSync(abs)) {
    throw new EditMatchError(
      `${relPath} does not exist, so there is nothing to edit. Use write_file to create it.`
    )
  }
  const oldContent = readFileSync(abs, 'utf-8')
  let newContent = oldContent
  for (const e of edits) {
    newContent = applyOneEdit(newContent, e.oldString, e.newString, e.replaceAll, relPath)
  }
  return { oldContent, newContent }
}
