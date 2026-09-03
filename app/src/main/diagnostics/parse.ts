/**
 * Pure parsers + formatter for the diagnostics feed (Phase 8).
 *
 * Sylor has no language server: Claude Code reads diagnostics from the editor it
 * lives in, and there is no editor here. So the project's OWN checkers are
 * invoked (`tsc`, `eslint`) and their output is turned into structured
 * {@link DiagnosticEntry}s. That normalization is the whole value of the tool —
 * the model gets a short, sorted, deduped list of `file:line:col  code  message`
 * instead of tens of kilobytes of raw compiler chatter.
 *
 * Everything here is pure text → data (no spawning, no fs), so every format
 * decision below is unit-tested against real checker output.
 */
import type { DiagnosticEntry } from '../../shared/types'

/**
 * `--pretty false` tsc line:
 *     src/main/foo.ts(12,3): error TS2345: Argument of type 'x' is not …
 * Captured: path, line, column, severity, code, message.
 */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/

/**
 * A tsc problem with no file position at all — a config-level failure, e.g.
 *     error TS18003: No inputs were found in config file …
 * Kept rather than dropped: "the compiler refused to start" is exactly the kind
 * of thing that must not be reported as a clean project.
 */
const TSC_GLOBAL = /^(error|warning)\s+(TS\d+):\s*(.*)$/

/** tsc's trailing tally line, which carries no new information for the model. */
const TSC_SUMMARY = /^Found \d+ errors?/

/**
 * Parses `tsc --noEmit --pretty false` output into entries.
 *
 * A tsc message can span several lines (the "Type 'A' is not assignable to type
 * 'B'" explanations are indented continuations of the line above), so an indented
 * line that follows a diagnostic is appended to it rather than dropped or treated
 * as a new problem.
 */
export function parseTscOutput(text: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue

    const match = TSC_LINE.exec(line)
    if (match) {
      entries.push({
        source: 'typescript',
        severity: match[4] === 'warning' ? 'warning' : 'error',
        file: normalizePath(match[1]),
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[5],
        message: match[6].trim()
      })
      continue
    }

    // A continuation of the previous message (tsc indents them). Fold it in so the
    // model reads the full explanation, which is usually where the fix actually is.
    if (/^\s/.test(rawLine) && entries.length > 0) {
      const previous = entries[entries.length - 1]
      if (previous.source === 'typescript') {
        previous.message = `${previous.message} ${line.trim()}`.trim()
        continue
      }
    }

    if (TSC_SUMMARY.test(line)) continue

    const global = TSC_GLOBAL.exec(line)
    if (global) {
      entries.push({
        source: 'typescript',
        severity: global[1] === 'warning' ? 'warning' : 'error',
        file: '',
        line: 0,
        column: 0,
        code: global[2],
        message: global[3].trim()
      })
    }
  }
  return entries
}

/** One file's worth of `eslint --format json`, as much of it as we rely on. */
interface EslintFileReport {
  filePath?: unknown
  messages?: unknown
}

/** One message inside an eslint file report. */
interface EslintMessage {
  ruleId?: unknown
  severity?: unknown
  message?: unknown
  line?: unknown
  column?: unknown
}

/**
 * Parses `eslint --format json` into entries, returning null when the text isn't
 * the expected JSON at all (a crashed eslint, a config that threw) — the caller
 * turns that into an honest "eslint could not run", never into "no problems".
 *
 * eslint reports absolute paths, so `root` is used to relativize them; a path
 * outside the root is left as-is rather than mangled.
 */
export function parseEslintJson(text: string, root = ''): DiagnosticEntry[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const entries: DiagnosticEntry[] = []
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue
    const report = raw as EslintFileReport
    const file = typeof report.filePath === 'string' ? toRelative(root, report.filePath) : ''
    if (!Array.isArray(report.messages)) continue
    for (const rawMessage of report.messages) {
      if (typeof rawMessage !== 'object' || rawMessage === null) continue
      const message = rawMessage as EslintMessage
      if (typeof message.message !== 'string' || !message.message.trim()) continue
      entries.push({
        source: 'eslint',
        // eslint severity: 2 = error, 1 = warning. Anything else (0 = off, which
        // never appears in a report) is treated as a warning — the safer read.
        severity: message.severity === 2 ? 'error' : 'warning',
        file,
        line: positionOf(message.line),
        column: positionOf(message.column),
        code: typeof message.ruleId === 'string' && message.ruleId ? message.ruleId : undefined,
        message: message.message.trim()
      })
    }
  }
  return entries
}

/** Ceiling on entries kept, so one broken import can't flood the context window. */
const MAX_ENTRIES = 50

/** Ceiling on the formatted report, applied after the entry cap. */
const MAX_CHARS = 12_000

/** Knobs for {@link prepareDiagnostics}; the defaults are the shipping values. */
export interface FormatOptions {
  maxEntries?: number
  maxChars?: number
}

/** Everything the {@link DiagnosticsResult} needs about a set of raw entries. */
export interface PreparedDiagnostics {
  /** Sorted, deduped and capped — what the renderer lists. */
  entries: DiagnosticEntry[]
  /** Counts BEFORE the cap, so a truncated report still states the real total. */
  errors: number
  warnings: number
  truncated: boolean
  output: string
  summary: string
}

/**
 * Sorts, dedupes, caps and formats entries into the report the model reads.
 *
 * Ordering is errors before warnings, then by file, line and column, so the first
 * thing the model sees is the first thing worth fixing. Project-level problems
 * (`file: ''`) sort ahead of everything — a compiler that refused to start
 * outranks any single type error.
 */
export function prepareDiagnostics(
  raw: DiagnosticEntry[],
  options: FormatOptions = {}
): PreparedDiagnostics {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const maxChars = options.maxChars ?? MAX_CHARS

  const sorted = dedupe(raw).sort(compareEntries)
  const errors = sorted.filter((entry) => entry.severity === 'error').length
  const warnings = sorted.length - errors
  const summary = summaryOf(errors, warnings)

  let entries = maxEntries > 0 ? sorted.slice(0, maxEntries) : sorted
  let truncated = entries.length < sorted.length
  let output = renderReport(entries, sorted.length, errors, warnings, truncated)

  // Character cap as a second pass: a handful of enormous tsc messages can blow
  // the budget while staying well under the entry cap. Drop from the tail (the
  // least severe, latest problems) until it fits, never mid-line.
  while (output.length > maxChars && entries.length > 1) {
    entries = entries.slice(0, entries.length - 1)
    truncated = true
    output = renderReport(entries, sorted.length, errors, warnings, truncated)
  }

  return { entries, errors, warnings, truncated, output, summary }
}

/** `3 errors, 2 warnings` / `1 error` / `clean` — the card's one-liner. */
export function summaryOf(errors: number, warnings: number): string {
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  return parts.length > 0 ? parts.join(', ') : 'clean'
}

/**
 * Drops exact repeats. Both checkers can report the same problem (a tsconfig
 * with two references compiles a shared file twice), and a duplicate reads as two
 * separate bugs to the model.
 */
function dedupe(entries: DiagnosticEntry[]): DiagnosticEntry[] {
  const seen = new Set<string>()
  const unique: DiagnosticEntry[] = []
  for (const entry of entries) {
    const key = [
      entry.source,
      entry.severity,
      entry.file,
      entry.line,
      entry.column,
      entry.code ?? '',
      entry.message
    ].join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  return unique
}

/** The ordering documented on {@link prepareDiagnostics}; total, so it's stable. */
function compareEntries(a: DiagnosticEntry, b: DiagnosticEntry): number {
  if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  if (a.column !== b.column) return a.column - b.column
  if (a.source !== b.source) return a.source < b.source ? -1 : 1
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
}

/**
 * eslint-stylish-shaped text: one path header per file, then `line:col severity
 * code message`. Grouping keeps the path out of every line (the cap is a token
 * budget) while leaving it copy-pasteable for a follow-up read.
 */
function renderReport(
  entries: DiagnosticEntry[],
  total: number,
  errors: number,
  warnings: number,
  truncated: boolean
): string {
  if (entries.length === 0) return 'No problems reported.'

  const lines: string[] = []
  let currentFile: string | null = null
  for (const entry of entries) {
    if (entry.file !== currentFile) {
      if (currentFile !== null) lines.push('')
      // '' means the checker gave no file at all — a config-level problem.
      lines.push(entry.file || '(project)')
      currentFile = entry.file
    }
    const position = entry.line > 0 ? `${entry.line}:${entry.column > 0 ? entry.column : 1}` : ''
    const bits = [position, entry.severity, entry.code ?? '', entry.message].filter(
      (bit) => bit !== ''
    )
    lines.push(`  ${bits.join('  ')}`)
  }

  lines.push('')
  lines.push(summaryOf(errors, warnings))
  if (truncated) {
    lines.push(`(showing the first ${entries.length} of ${total} — fix these first, then re-run)`)
  }
  return lines.join('\n')
}

/** A 1-based position, or 0 when the checker gave none (some fatal messages). */
function positionOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Backslashes → forward slashes, and no leading `./`, so paths compare + sort. */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * A checker's path expressed relative to the project root, POSIX-style. Both
 * sides are normalized first (checkers mix separators on Windows) and the compare
 * is case-insensitive there. A path that isn't under the root is returned
 * normalized but otherwise untouched — better an absolute path than a wrong one.
 */
export function toRelative(root: string, path: string): string {
  const file = normalizePath(path)
  if (!root) return file
  const base = normalizePath(root).replace(/\/+$/, '')
  if (!base) return file
  const a = process.platform === 'win32' ? file.toLowerCase() : file
  const b = process.platform === 'win32' ? base.toLowerCase() : base
  return a.startsWith(`${b}/`) ? file.slice(base.length + 1) : file
}
