/**
 * Static verification of a file the agent just wrote.
 *
 * The project-level check (`npm run typecheck` / `lint` / `build`) runs once at
 * the end of an orchestrated turn — valuable, but too late and too coarse to stop
 * the failure users actually hit: the agent writes a file, believes it, moves on,
 * and the result is a blank page or a project that won't start. Worse, most of
 * those projects have no npm script to run at all (a scaffolded HTML/CSS/JS
 * folder), so the end-of-run check reports "unverified" and nothing is caught.
 *
 * So every applied write is checked *immediately*, here, using only the bytes we
 * just wrote plus the filesystem — no subprocess, no toolchain, no network, a
 * fraction of a millisecond. Anything found is fed back into the agent loop as
 * part of that write's result, which is what turns "wrote a broken file" into
 * "wrote a file, saw the problem, fixed it" on the very next iteration.
 *
 * The checks are deliberately narrow, and every one of them targets a failure
 * that is otherwise **silent**:
 *  - malformed JSON (a broken `package.json` breaks every later command);
 *  - a truncated or structurally unbalanced source file (a cut-off stream);
 *  - an HTML page pointing at a stylesheet/script/image that isn't there;
 *  - a relative import that resolves to nothing (the classic white screen).
 *
 * False positives are the one thing that would make this harmful — an agent that
 * "fixes" working code is worse than one that doesn't look. So each check is
 * conservative by construction, skips anything it cannot judge confidently, and
 * every heuristic below documents what it deliberately lets through.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { resolveSafe } from './operations'

/** A problem found in freshly written content. */
export interface WriteIssue {
  /**
   * `error` — the file is definitely broken as written (it cannot parse, or it
   * references something that does not exist). `warning` — very likely broken,
   * but a build step could conceivably resolve it.
   */
  severity: 'error' | 'warning'
  /** One line, written for the model: what's wrong and where. */
  message: string
}

/**
 * Upper bound on issues reported for one file. A pathological file (a huge
 * generated blob, or one the model truncated early) could otherwise produce
 * hundreds of lines of feedback and crowd out the conversation.
 */
const MAX_ISSUES = 8

/** Sources whose structure we can scan (braces, strings, comments). */
const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const CSS_EXTS = new Set(['.css', '.scss', '.less'])

/**
 * File names that look like JSON but are really JSONC — comments and trailing
 * commas are legal and every toolchain that reads them accepts both. Parsing
 * these strictly would report a "syntax error" in a perfectly valid tsconfig,
 * which is exactly the sort of false positive that would send the agent off
 * "fixing" working files.
 */
function isJsonWithComments(relPath: string): boolean {
  const name = posix.basename(relPath).toLowerCase()
  return (
    /^(ts|js)config(\..+)?\.json$/.test(name) ||
    /(^|\/)\.vscode\//.test(relPath.toLowerCase()) ||
    name.endsWith('.jsonc')
  )
}

/**
 * Checks a file the agent just wrote, returning everything provably wrong with
 * it. An empty array means "nothing detectable" — never "verified correct", a
 * distinction the caller is careful to preserve when it reports back.
 *
 * Never throws: a check that cannot run (an unreadable directory, a path outside
 * the sandbox) contributes no issues rather than failing the write, which has
 * already landed on disk by this point.
 */
export function verifyWrittenFile(relPath: string, content: string): WriteIssue[] {
  const ext = extensionOf(relPath)
  const issues: WriteIssue[] = []

  try {
    if (ext === '.json' && !isJsonWithComments(relPath)) {
      issues.push(...checkJson(content))
    }

    if (JS_EXTS.has(ext) || CSS_EXTS.has(ext)) {
      const scan = scanSource(content, CSS_EXTS.has(ext) ? 'css' : 'js')
      issues.push(...scan.issues)
      // Only chase imports in a file that parsed cleanly: in a truncated file the
      // dangling half-written import at the end is noise, and the structural
      // error above already says the real problem.
      if (scan.issues.length === 0 && JS_EXTS.has(ext)) {
        issues.push(...checkRelativeImports(relPath, scan.withoutComments))
      }
    }

    if (ext === '.html' || ext === '.htm') {
      issues.push(...checkHtmlAssets(relPath, content))
    }
  } catch {
    // Verification is a courtesy, never a gate. If anything in it throws, the
    // write still stands and we simply report nothing.
    return []
  }

  return issues.slice(0, MAX_ISSUES)
}

/**
 * Re-runs {@link verifyWrittenFile} against a file's current contents on disk.
 *
 * Needed because an issue can be resolved by a write to a *different* file: an
 * HTML page missing its stylesheet is fixed by creating the stylesheet, not by
 * touching the page. Re-checking before acting on a stale issue is what keeps the
 * agent from being sent to "fix" a file that is already fine. A file that no
 * longer exists (renamed, deleted) reports nothing.
 */
export function recheckWrittenFile(relPath: string): WriteIssue[] {
  try {
    const abs = resolveSafe(relPath)
    if (!existsSync(abs) || !statSync(abs).isFile()) return []
    return verifyWrittenFile(relPath, readFileSync(abs, 'utf8'))
  } catch {
    return []
  }
}

/** Lowercased extension including the dot, or '' when there is none. */
function extensionOf(relPath: string): string {
  const ext = posix.extname(posix.basename(relPath))
  return ext.toLowerCase()
}

/** 1-based line number of a character offset. */
function lineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/** Strict JSON parse, reporting the parser's own message (it names the offset). */
function checkJson(content: string): WriteIssue[] {
  if (content.trim() === '') return []
  try {
    JSON.parse(content)
    return []
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return [{ severity: 'error', message: `not valid JSON — ${detail}` }]
  }
}

/**
 * The result of one structural pass over a source file: what's wrong with it,
 * plus the same text with every comment blanked out (spaces, so offsets and line
 * numbers still line up). The stripped copy is what the import scan reads, so a
 * commented-out import of a since-deleted file is never reported.
 */
interface ScanResult {
  issues: WriteIssue[]
  withoutComments: string
}

/**
 * Single-pass structural scan: tracks strings, template literals (including
 * nested `${…}`), comments, and — for JS — regex literals, so the bracket depth
 * it reports reflects real code rather than punctuation inside a string.
 *
 * Reports only two things, both of which mean the file is genuinely unusable:
 *  - something still open at EOF (a string, a template, a block comment, or a
 *    bracket) — the signature of a write that was cut off mid-file;
 *  - a closer that contradicts the innermost opener (`{ … )`).
 *
 * It deliberately does NOT report a closer that arrives with nothing open. That
 * is the one case a mis-tokenized regex or an exotic template can manufacture,
 * and staying quiet there is what keeps this check trustworthy enough to act on.
 */
function scanSource(content: string, flavor: 'js' | 'css'): ScanResult {
  const stack: Array<{ ch: string; index: number }> = []
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const issues: WriteIssue[] = []
  const stripped = content.split('')

  /** Template-literal frames: a `}` closing one of these resumes the template. */
  const templateDepths: number[] = []
  let i = 0
  /** Last significant character seen, used to tell regex from division. */
  let prev = ''

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < stripped.length; k++) {
      if (stripped[k] !== '\n') stripped[k] = ' '
    }
  }

  while (i < content.length) {
    const ch = content[i]

    // ── comments ──────────────────────────────────────────────────────────
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      if (end === -1) {
        issues.push({
          severity: 'error',
          message: `unterminated block comment opened on line ${lineAt(content, i)} — the file looks truncated`
        })
        blank(i, content.length)
        i = content.length
        break
      }
      blank(i, end + 2)
      i = end + 2
      continue
    }
    // `//` is a comment in JS and, by universal preprocessor convention, in
    // .scss/.less too. Plain .css doesn't have it, but treating it as one there
    // can only under-report, never invent an issue.
    if (ch === '/' && content[i + 1] === '/') {
      const end = content.indexOf('\n', i)
      const stop = end === -1 ? content.length : end
      blank(i, stop)
      i = stop
      continue
    }

    // ── strings ───────────────────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      const closed = skipQuoted(content, i, ch)
      if (closed === -1) {
        issues.push({
          severity: 'error',
          message: `unterminated string starting on line ${lineAt(content, i)} — the file looks truncated`
        })
        i = content.length
        break
      }
      i = closed
      prev = ch
      continue
    }

    // ── template literals (JS only) ───────────────────────────────────────
    if (flavor === 'js' && ch === '`') {
      const end = skipTemplate(content, i, stack, templateDepths)
      if (end === -1) {
        issues.push({
          severity: 'error',
          message: `unterminated template literal starting on line ${lineAt(content, i)} — the file looks truncated`
        })
        i = content.length
        break
      }
      // `end` may land mid-template at a `${`, in which case the interpolation is
      // scanned as ordinary code and the matching `}` resumes the template.
      i = end
      prev = '`'
      continue
    }

    // ── regex literals (JS only) ──────────────────────────────────────────
    if (flavor === 'js' && ch === '/' && startsRegex(prev)) {
      const end = skipRegex(content, i)
      if (end !== -1) {
        i = end
        prev = '/'
        continue
      }
      // Unterminated-looking: treat the slash as division and carry on rather
      // than claiming a truncation we're not sure about.
    }

    // ── brackets ──────────────────────────────────────────────────────────
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, index: i })
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === '}' && templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === stack.length) {
        // Closes a `${…}`: resume scanning the enclosing template literal.
        templateDepths.pop()
        const end = resumeTemplate(content, i + 1, stack, templateDepths)
        if (end === -1) {
          issues.push({
            severity: 'error',
            message: `unterminated template literal in this file — it looks truncated`
          })
          i = content.length
          break
        }
        i = end
        prev = '`'
        continue
      }
      const top = stack[stack.length - 1]
      if (top && top.ch !== pairs[ch]) {
        issues.push({
          severity: 'error',
          message: `'${ch}' on line ${lineAt(content, i)} does not close '${top.ch}' from line ${lineAt(content, top.index)}`
        })
        // One structural report is enough; past this point the depth is guesswork.
        return { issues, withoutComments: stripped.join('') }
      }
      if (top) stack.pop()
    }

    if (!/\s/.test(ch)) prev = ch
    i++
  }

  if (issues.length === 0 && stack.length > 0) {
    const open = stack[0]
    const more = stack.length > 1 ? ` (${stack.length} unclosed in total)` : ''
    issues.push({
      severity: 'error',
      message: `'${open.ch}' opened on line ${lineAt(content, open.index)} is never closed${more} — the file looks truncated or unbalanced`
    })
  }

  return { issues, withoutComments: stripped.join('') }
}

/**
 * Index just past the closing quote of the string starting at `start`, or -1 when
 * it never closes. A newline inside a single/double-quoted string is itself a
 * syntax error, so it ends the search — that's how a truncated line is caught.
 */
function skipQuoted(content: string, start: number, quote: string): number {
  for (let i = start + 1; i < content.length; i++) {
    const ch = content[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '\n') return -1
    if (ch === quote) return i + 1
  }
  return -1
}

/**
 * Scans a template literal from its opening backtick. Returns the index just past
 * the closing backtick, or — when it hits a `${` — the index just past that, with
 * the interpolation depth recorded so the matching `}` resumes the template.
 */
function skipTemplate(
  content: string,
  start: number,
  stack: Array<{ ch: string; index: number }>,
  templateDepths: number[]
): number {
  return resumeTemplate(content, start + 1, stack, templateDepths)
}

/** Continues a template literal at `from` (just inside it). See {@link skipTemplate}. */
function resumeTemplate(
  content: string,
  from: number,
  stack: Array<{ ch: string; index: number }>,
  templateDepths: number[]
): number {
  for (let i = from; i < content.length; i++) {
    const ch = content[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`') return i + 1
    if (ch === '$' && content[i + 1] === '{') {
      // The interpolation is real code: record the depth its `}` must return to.
      templateDepths.push(stack.length)
      return i + 2
    }
  }
  return -1
}

/**
 * Whether a `/` at this point starts a regex literal rather than division, judged
 * from the previous significant character. After a value — an identifier, a
 * number, or a closing bracket — it's division; anywhere else (after `=`, `(`,
 * `,`, `return`, …) it's a regex. This is the standard lightweight heuristic, with
 * one addition that matters enormously here: `<` counts as a value.
 *
 * Every JSX closing tag is `</…`, so without that, `</div>` would open a "regex"
 * that runs to the next `/` on the line — and if it swallowed a real `)` or `}`
 * on the way (`{items.map(i => <li>{i}</li>)}`) the bracket depth would end up
 * wrong and a perfectly good React component would be reported as truncated.
 * A regex that legitimately follows `<` (`a < /re/.test(b)`) is not real code.
 *
 * `=>` is why `>` is NOT treated as a value: `arr.filter(s => /^a/.test(s))` is
 * ordinary, and misreading that regex as division would leak its `{` onto the
 * bracket stack. The residual cases this still gets wrong (a regex opening a
 * statement right after `}`) are why {@link scanSource} refuses to report surplus
 * closers — a misparse can then only ever hide a problem, never invent one.
 */
function startsRegex(prev: string): boolean {
  if (prev === '') return true
  return !/[\w$)\]'"`<]/.test(prev)
}

/** Index just past the closing `/` of a regex literal, or -1 if it doesn't close. */
function skipRegex(content: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < content.length; i++) {
    const ch = content[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '\n') return -1
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === '/') {
      // Skip trailing flags so `prev` ends up on an identifier char, not the slash.
      let j = i + 1
      while (j < content.length && /[a-z]/i.test(content[j])) j++
      return j
    }
  }
  return -1
}

/**
 * Module specifiers in import / export / require / dynamic-import position. Runs
 * over comment-stripped text, so it never picks up a commented-out import.
 */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/g

/** Extensions tried, in order, when a relative import omits one. */
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte']

/**
 * Reports relative imports that resolve to nothing on disk — the single most
 * common cause of a React/Vue app rendering a blank page, and completely silent
 * until someone opens the browser console.
 *
 * Only `./` and `../` specifiers are checked. Bare names (`react`), scoped
 * packages, and alias prefixes (`@/`, `~/`, `@shared/`) all depend on
 * node_modules or a bundler/tsconfig alias table, so judging them here would
 * produce confident nonsense.
 */
function checkRelativeImports(relPath: string, code: string): WriteIssue[] {
  const dir = posix.dirname(relPath)
  const issues: WriteIssue[] = []
  const seen = new Set<string>()

  for (const match of code.matchAll(SPECIFIER_RE)) {
    const raw = match[1]
    if (!raw.startsWith('./') && !raw.startsWith('../')) continue
    // Vite-style suffixes (`?raw`, `?url`) and fragments aren't part of the path.
    const spec = raw.split(/[?#]/)[0]
    if (spec === '' || seen.has(spec)) continue
    seen.add(spec)

    const target = posix.normalize(posix.join(dir, spec))
    // A specifier that climbs out of the project root can't be judged from here:
    // the sandbox stops us reading it, and in a monorepo (root set to `app/`,
    // sources importing `../../shared/x`) it is perfectly legitimate. Claiming it
    // doesn't exist would be a confident lie.
    if (escapesRoot(target)) continue
    if (!resolvesOnDisk(target)) {
      issues.push({
        severity: 'error',
        message: `imports '${raw}' (line ${lineAt(code, match.index)}) but no such file exists — create it or fix the path`
      })
    }
  }
  return issues
}

/**
 * Whether a project-relative import target exists, trying the path as-is, then
 * each candidate extension, then `index.*` inside it. A directory that exists but
 * has no index still counts as resolved: package `main` fields and bundler
 * conventions can make that work, and guessing wrong here would be a false alarm.
 */
function resolvesOnDisk(target: string): boolean {
  for (const ext of RESOLVE_EXTS) {
    if (fileExists(`${target}${ext}`)) return true
  }
  if (directoryExists(target)) return true
  return false
}

/**
 * Whether a normalized project-relative path climbs out of the project root.
 * Such a path is outside what we can see, so every check treats it as unknowable
 * rather than missing — see {@link checkRelativeImports}.
 */
function escapesRoot(target: string): boolean {
  return target === '..' || target.startsWith('../')
}

/** Sandbox-checked file existence; anything outside the root is simply "unknown". */
function fileExists(relPath: string): boolean {
  try {
    const abs = resolveSafe(relPath)
    return existsSync(abs) && statSync(abs).isFile()
  } catch {
    return false
  }
}

/** Sandbox-checked directory existence. */
function directoryExists(relPath: string): boolean {
  try {
    const abs = resolveSafe(relPath)
    return existsSync(abs) && statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/** HTML comments, blanked before attributes are scanned. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g

/**
 * Render-blocking resource references: the attributes whose target must exist for
 * the page to look right. `<a href>` is deliberately excluded — a link to a page
 * that isn't written yet is normal mid-build, not a defect.
 */
const HTML_ASSET_RE =
  /<(script|link|img|source|video|audio|iframe)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi

/**
 * Reports local stylesheets/scripts/images an HTML page points at that aren't
 * there. This is the concrete, checkable half of the blank-page problem: the page
 * loads, the asset 404s, and the user sees white with no error anywhere in Sylor.
 *
 * Remote URLs, protocol-relative URLs, data/blob URIs, fragments, and anything
 * carrying a template placeholder (`{{ }}`, `<% %>`, `${ }`) are skipped — none of
 * them are ours to resolve.
 */
function checkHtmlAssets(relPath: string, content: string): WriteIssue[] {
  const html = content.replace(HTML_COMMENT_RE, (m) => ' '.repeat(m.length))
  const dir = posix.dirname(relPath)
  const issues: WriteIssue[] = []
  const seen = new Set<string>()

  for (const match of html.matchAll(HTML_ASSET_RE)) {
    const [, tag, attr, ref] = match
    // A <link> only blocks rendering for real assets; rel="canonical" etc. don't.
    if (tag.toLowerCase() === 'link' && !/\brel\s*=\s*["'][^"']*(stylesheet|icon|preload)/i.test(match[0])) {
      continue
    }
    if (!isLocalRef(ref) || seen.has(ref)) continue
    seen.add(ref)

    // A root-relative `/x` resolves from the project root (that's how the preview
    // server serves it); anything else from the page's own directory.
    const target = ref.startsWith('/')
      ? posix.normalize(ref.slice(1))
      : posix.normalize(posix.join(dir, ref))
    if (escapesRoot(target)) continue

    if (!fileExists(target)) {
      issues.push({
        severity: 'error',
        message: `<${tag.toLowerCase()} ${attr}="${ref}"> (line ${lineAt(html, match.index)}) points at a file that doesn't exist — the page will render without it`
      })
    }
  }
  return issues
}

/** Whether an HTML reference is a local project path we can check. */
function isLocalRef(ref: string): boolean {
  const value = ref.trim()
  if (value === '' || value.startsWith('#') || value.startsWith('//')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false // http:, data:, blob:, mailto:
  if (/\{\{|\{%|<%|\$\{/.test(value)) return false // template placeholder
  return true
}

/**
 * The note appended to a write's result so the agent sees what it just broke, or
 * '' when nothing was found. Takes the plain messages carried on the result (see
 * `WriteFileResult.issues`) and phrases them as an instruction, because this text
 * is fed straight back into the loop, where the next iteration acts on it.
 *
 * Silence here means "nothing detectable", never "verified" — so a clean file
 * adds nothing at all rather than a reassuring claim the check can't support.
 */
export function describeIssues(messages: readonly string[]): string {
  if (messages.length === 0) return ''
  const label = messages.length === 1 ? 'problem' : 'problems'
  return (
    `⚠ ${messages.length} ${label} detected in what you just wrote:\n` +
    messages.map((message) => `  - ${message}`).join('\n') +
    `\nFix this before moving on.`
  )
}
