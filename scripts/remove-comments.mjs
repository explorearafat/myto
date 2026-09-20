#!/usr/bin/env node
/*
 * Remove comment syntax from TypeScript, JavaScript and Dart source files.
 *
 * Comment positions for JS/TS/TSX come from the UNION of two scanners:
 *   1. the TypeScript compiler's own comment ranges (ts.getLeading/Trailing
 *      CommentRanges) — authoritative for strings, template literals, regex
 *      literals, decorators and JSX, which it parses rather than guesses; and
 *   2. a small character state machine — authoritative where the public range
 *      API is lossy, e.g. the first comment after a shebang line.
 * A hit from (2) that is not confirmed by (1) is dropped when it falls inside
 * a JsxText span, so slash-slash or slash-star text written in JSX copy
 * survives while a brace-slash-star comment expression still goes.
 * NOTE: never put a real comment closer inside this header, not even as an
 * example — the first one ends the block early and breaks the file's syntax.
 * Shebangs are never collected by either scanner, so they are untouched.
 * Dart has no analyzer available here, so it uses the state machine alone,
 * tracking string, raw-string, triple-quoted, `${}` interpolation state and
 * Dart's nested block comments.
 *
 * Removal itself is one byte-mask pass: a line whose non-whitespace bytes were
 * all comment is dropped whole, a line that shared itself with code keeps that
 * code and its indentation.
 *
 * Tool directives (@ts-*, eslint-*, ignore_for_file:, @license, /*! blocks)
 * change behaviour when dropped, so they are kept unless --strip-directives.
 *
 * Usage:
 *   node scripts/remove-comments.mjs                     dry-run: counts + report
 *   node scripts/remove-comments.mjs --write             apply the removals
 *   node scripts/remove-comments.mjs --check             exit 1 if any remain
 *   node scripts/remove-comments.mjs --strip-directives  also remove kept directives
 *   node scripts/remove-comments.mjs [path ...]          restrict to paths
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const SINGLE = ts.SyntaxKind.SingleLineCommentTrivia
const MULTI = ts.SyntaxKind.MultiLineCommentTrivia

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.dart'])
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', 'release', 'coverage', '.dart_tool',
  '.git', '.vite', '.vercel', '.next', '.turbo', '.cache', '.parcel-cache', '.idea',
])
// The cleaner is documentation for whoever maintains it; it never cleans itself.
const SELF = new Set(['scripts/remove-comments.mjs', 'scripts/remove-comments.test.mjs'])
const DEFAULT_TARGETS = [
  'src', 'api', 'app/src', 'app/scripts', 'scripts',
  'mobile/lib', 'mobile/test',
  'vite.config.ts', 'app/vite.preview.config.ts', 'app/vitest.config.ts',
  'app/electron.vite.config.ts', 'app/eslint.config.js',
]
const MAX_BYTES = 4 * 1024 * 1024
const REPORT_PATH = 'scripts/comment-clean-report.md'

const DIRECTIVES = [
  /(^|\s)@ts-(ignore|expect-error|check|nocheck|noscope)\b/,
  /(^|\s)@(type|satisfies)\b/,
  /#(start-|stop-)?region\b/,
  /(^|\s)eslint(-[a-z-]+)?\b/,
  /(^|\s)(prettier|biome|stylelint)(-|:|\s|$)/,
  /istanbul\s+ignore\b/,
  /sourceMappingURL/,
  /\bcoverage\s+(ignore|disable|enable)\b/,
  /(^|\s)(webpackInclude|webpackIgnore|webpackChunkName|webpackMode|webpackPrefetch)\b/,
  /(^|\s)vite:[a-z-]+/,
  /\bdart\s+format\b/,
  /ignore_for_file\s*:/,
  /(^|\s)ignore\s*:\s*[A-Za-z_]/,
]
const LICENSE = /(^|\s)@(license|preserve|cc_on)\b/

const REGEX_BEFORE_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'do', 'else', 'await', 'yield', 'case',
])
const REGEX_BEFORE_SYMBOLS = new Set([
  '(', ',', ':', '=', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '~', '^', '<', '>', ')',
])

export function isKeptComment(body, keepDirectives = true) {
  if (!keepDirectives) return false
  if (body.startsWith('/*!')) return true
  if (LICENSE.test(body)) return true
  const text = body.replace(/^\/\/+/, '').replace(/^\/\*+/, '').replace(/\*+\/?$/, '')
  return DIRECTIVES.some((re) => re.test(text))
}

/** Range helpers: the scanner output is { pos, end, kind } over the same text. */
function dedupe(ranges) {
  const byStart = new Map()
  for (const r of ranges) {
    if (r.end <= r.pos) continue
    if (!byStart.has(r.pos)) byStart.set(r.pos, { pos: r.pos, end: r.end, kind: r.kind })
  }
  return [...byStart.values()].sort((a, b) => a.pos - b.pos)
}

/** Comment ranges the TypeScript parser recognises in a JS/TS/TSX file. */
export function tsCommentRanges(filePath, text, sf = null) {
  const source =
    sf ||
    ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const found = []
  const add = (ranges) => {
    if (ranges) for (const r of ranges) found.push(r)
  }
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.pos))
    add(ts.getTrailingCommentRanges(text, node.end))
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  add(ts.getLeadingCommentRanges(text, source.endOfFileToken.pos))
  return dedupe(found)
}

function scriptKindFor(filePath) {
  const ext = path.extname(filePath)
  if (ext === '.tsx' || ext === '.jsx') return ts.ScriptKind.TSX
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Spans of literal JSX text, where `//` is prose and not a comment. */
function jsxTextRanges(sf) {
  const spans = []
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) spans.push([node.getStart(sf) - 1, node.end])
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return spans
}

/** State-machine comment ranges for JS/TS: strings, templates, regex tracked. */
export function jsCommentRanges(text) {
  const n = text.length
  const found = []
  const stack = []
  let word = ''
  let symbol = ''
  let i = 0
  const regexAllowed = () =>
    word ? REGEX_BEFORE_KEYWORDS.has(word) : symbol === '' || REGEX_BEFORE_SYMBOLS.has(symbol)

  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    const top = stack[stack.length - 1]

    if (top && top.kind === 'tpl') {
      if (c === '\\') { i += 2; continue }
      if (c === '`') { stack.pop(); i++; word = ''; symbol = ')'; continue }
      if (c === '$' && d === '{') {
        stack.push({ kind: 'expr', braces: 0 })
        i += 2; word = ''; symbol = '{'; continue
      }
      i++
      continue
    }

    if (i === 0 && c === '#' && d === '!') {
      const eol = text.indexOf('\n', i)
      i = eol === -1 ? n : eol
      continue
    }

    if (c === '/' && d === '/') {
      // Only a comment when it opens the line or follows whitespace: `https://x`
      // and `a//b` keep their slashes.
      const prev = text[i - 1]
      const lineStart = i === 0 || text[i - 1] === '\n'
      if (!lineStart && !(prev !== undefined && /\s/.test(prev))) {
        i++; word = ''; symbol = '/'
        continue
      }
      const eol = text.indexOf('\n', i)
      const end = eol === -1 ? n : eol
      found.push({ pos: i, end, kind: SINGLE })
      i = end
      continue
    }

    if (c === '/' && d === '*') {
      const prevCh = text[i - 1] || ''
      if (/[A-Za-z0-9_$]/.test(prevCh)) {
        i++; word = ''; symbol = '/'
        continue
      }
      let j = i + 2
      while (j < n && !text.startsWith('*/', j)) j++
      j = Math.min(j + 2, n)
      found.push({ pos: i, end: j, kind: MULTI })
      i = j
      continue
    }

    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n) {
        const x = text[j]
        if (x === '\\') { j += 2; continue }
        if (x === c || x === '\n') break
        j++
      }
      i = j
      word = ''; symbol = ')'
      continue
    }

    if (c === '`') {
      stack.push({ kind: 'tpl' })
      i++; word = ''; symbol = ')'
      continue
    }

    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let cls = false
      let terminated = false
      while (j < n) {
        const x = text[j]
        if (x === '\\') { j += 2; continue }
        if (x === '\n') break
        if (cls) { if (x === ']') cls = false; j++; continue }
        if (x === '[') { cls = true; j++; continue }
        if (x === '/') { j++; terminated = true; break }
        j++
      }
      if (terminated) {
        while (j < n && /[a-z]/i.test(text[j])) j++
        i = j
        word = ''; symbol = ')'
        continue
      }
    }

    if (c === '{') {
      if (top && top.kind === 'expr') top.braces++
      i++; word = ''; symbol = '{'
      continue
    }
    if (c === '}') {
      if (top && top.kind === 'expr') {
        if (top.braces === 0) stack.pop()
        else top.braces--
      }
      i++; word = ''; symbol = '}'
      continue
    }

    if (/\s/.test(c)) {
      // whitespace leaves the last significant token alone
    } else if (/[A-Za-z0-9_$]/.test(c)) {
      word += c
      symbol = ''
    } else {
      word = ''
      symbol = c
    }
    i++
  }
  return found
}

/** State-machine comment ranges for Dart: nested blocks and raw strings too. */
export function dartCommentRanges(text) {
  const n = text.length
  const found = []
  const stack = []
  const isIdent = (ch) => /[A-Za-z0-9_$]/.test(ch)
  let i = 0
  let raw = false
  while (i < n) {
    const top = stack[stack.length - 1]
    const c = text[i]
    const d = text[i + 1]

    if (top && top.kind === 'str') {
      if (!top.raw) {
        if (c === '\\') { i += 2; continue }
        if (c === '$' && d === '{') { stack.push({ kind: 'code', braces: 0 }); i += 2; continue }
      }
      if (c === top.q) {
        if (top.triple) {
          if (text.startsWith(top.q + top.q + top.q, i)) { stack.pop(); i += 3 }
          else i++
        } else { stack.pop(); i++ }
        continue
      }
      i++
      continue
    }

    if (i === 0 && c === '#' && d === '!') {
      const eol = text.indexOf('\n', i)
      i = eol === -1 ? n : eol
      continue
    }
    if (c === '/' && d === '/') {
      const eol = text.indexOf('\n', i)
      const end = eol === -1 ? n : eol
      found.push({ pos: i, end, kind: SINGLE })
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      let j = i + 2
      let depth = 1
      while (j < n && depth > 0) {
        if (text.startsWith('*/', j)) { depth--; j += 2 }
        else if (text.startsWith('/*', j)) { depth++; j += 2 }
        else j++
      }
      found.push({ pos: i, end: j, kind: MULTI })
      i = j
      continue
    }
    if (c === 'r' && (d === '"' || d === "'") && !isIdent(text[i - 1] || '')) {
      raw = true
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const triple = text[i + 1] === c && text[i + 2] === c
      stack.push({ kind: 'str', q: c, triple, raw })
      raw = false
      i += triple ? 3 : 1
      continue
    }
    if (top && top.kind === 'code') {
      if (c === '{') top.braces++
      else if (c === '}') {
        if (top.braces === 0) stack.pop()
        else top.braces--
      }
    }
    i++
  }
  return found
}

/** The ranges to remove from one file, however it is parsed. */
export function commentRangesFor(filePath, text) {
  if (path.extname(filePath) === '.dart') return dedupe(dartCommentRanges(text))
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const api = tsCommentRanges(filePath, text, sf)
  const known = new Set(api.map((r) => r.pos))
  const jsxText = jsxTextRanges(sf)
  const inJsxText = (r) => jsxText.some(([s, e]) => r.pos >= s && r.pos < e)
  const merged = api.slice()
  for (const r of jsCommentRanges(text)) {
    if (known.has(r.pos)) continue
    if (inJsxText(r)) continue
    merged.push(r)
  }
  return dedupe(merged)
}

/**
 * Blank out the removable comments in `text`. A line made only of comment plus
 * whitespace disappears; a line that also carries code keeps it, with the
 * comment bytes cut and the original indentation preserved.
 */
export function applyRemovals(text, ranges, keepDirectives = true) {
  const removals = []
  let kept = 0
  for (const r of ranges) {
    if (r.end <= r.pos) continue
    if (isKeptComment(text.slice(r.pos, r.end), keepDirectives)) kept++
    else removals.push(r)
  }
  const stats = {
    line: removals.filter((r) => r.kind === SINGLE).length,
    block: removals.filter((r) => r.kind === MULTI).length,
    kept,
  }
  if (!removals.length) return { out: text, stats }

  const mask = new Uint8Array(text.length)
  for (const r of removals) mask.fill(1, r.pos, Math.min(r.end, text.length))

  const isGap = (ch) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
  const out = []
  let offset = 0
  for (const raw0 of text.split('\n')) {
    const raw = raw0.endsWith('\r') ? raw0.slice(0, -1) : raw0
    const start = offset
    offset += raw0.length + 1
    let first = -1
    let last = -1
    for (let k = 0; k < raw.length; k++) {
      if (!isGap(raw[k])) {
        if (first === -1) first = k
        last = k
      }
    }
    if (first === -1) { out.push(raw0); continue }
    let allComment = true
    for (let k = first; k <= last; k++) {
      if (!isGap(raw[k]) && !mask[start + k]) { allComment = false; break }
    }
    if (allComment) continue
    const leadingWasComment = mask[start + first] === 1
    let rebuilt = ''
    for (let k = 0; k < raw.length; k++) if (!mask[start + k]) rebuilt += raw[k]
    rebuilt = leadingWasComment ? raw.slice(0, first) + rebuilt.trimStart() : rebuilt.trimEnd()
    out.push(raw0.endsWith('\r') ? rebuilt + '\r' : rebuilt)
  }
  return { out: out.join('\n'), stats }
}

export function stripComments(src, opts = {}) {
  const keepDirectives = opts.keepDirectives !== false
  const file = opts.path || (opts.dart ? 'file.dart' : 'file.ts')
  return applyRemovals(src, commentRangesFor(file, src), keepDirectives)
}

export async function collectFiles(targets) {
  const found = new Set()
  async function walk(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(p)
      } else if (CODE_EXTS.has(path.extname(e.name)) && !e.name.startsWith('.')) {
        const rel = p.split(path.sep).join('/')
        if (!SELF.has(rel)) found.add(p)
      }
    }
  }
  for (const t of targets) {
    if (CODE_EXTS.has(path.extname(t))) {
      const rel = t.split(path.sep).join('/')
      if (!SELF.has(rel)) found.add(t)
    } else await walk(t)
  }
  return [...found].sort()
}

async function main() {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const check = argv.includes('--check')
  const keepDirectives = !argv.includes('--strip-directives')
  const args = argv.filter((a) => !a.startsWith('--'))
  const targets = args.length ? args : DEFAULT_TARGETS
  const files = await collectFiles(targets)

  const rows = []
  let dirty = 0
  let lineTotal = 0
  let blockTotal = 0
  let keptTotal = 0
  for (const f of files) {
    let buf
    try { buf = await fs.readFile(f) } catch {
      rows.push(`| \`${f}\` | — | — | — | — | skipped: unreadable |`)
      continue
    }
    if (buf.length > MAX_BYTES || buf.includes(0)) {
      rows.push(`| \`${f}\` | — | — | — | — | skipped: binary or over ${MAX_BYTES} bytes |`)
      continue
    }
    const src = buf.toString('utf8')
    const { out, stats } = stripComments(src, {
      dart: path.extname(f) === '.dart',
      path: f,
      keepDirectives,
    })
    if (stats.line + stats.block === 0) continue
    dirty++
    lineTotal += stats.line
    blockTotal += stats.block
    keptTotal += stats.kept
    rows.push(`| \`${f}\` | ${path.extname(f)} | ${stats.line} | ${stats.block} | ${stats.kept} | ${write ? 'applied' : 'dry-run'} |`)
    if (write && out !== src) await fs.writeFile(f, out, 'utf8')
  }

  const header = [
    '# Comment-clean report',
    '',
    `Mode: ${check ? 'check' : write ? 'write' : 'dry-run'} · directives ${keepDirectives ? 'preserved' : 'stripped'} · ${files.length} files scanned, ${dirty} with removable comments · ${lineTotal} line + ${blockTotal} block removable, ${keptTotal} directives kept.`,
    '',
    `JS/TS ranges are the union of the TypeScript parser and a string/template/regex-aware state machine, minus lexer-only hits inside JSX text; Dart is the state machine alone. The cleaner itself (${[...SELF].join(', ')}) is never a target.`,
    '',
    '| File | Ext | Line | Block | Kept | Status |',
    '|---|---|---|---|---|---|',
  ]
  await fs.writeFile(
    REPORT_PATH,
    header.concat(rows.length ? rows : ['| (none) | | | | | |']).join('\n') + '\n',
    'utf8',
  )
  console.log(
    `[remove-comments] ${files.length} scanned · ${dirty} with removable comments · ${lineTotal} line + ${blockTotal} block removable · ${keptTotal} directives kept · report: ${REPORT_PATH}`,
  )
  if (check && dirty) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
