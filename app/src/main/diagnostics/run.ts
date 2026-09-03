/**
 * The diagnostics feed (Phase 8): runs the project's OWN checkers and returns
 * their problems as structured data — Sylor's stand-in for an editor language
 * server.
 *
 * Three deliberate shapes here:
 *
 * 1. **`execFile`, never `runCommand`.** The terminal runner is pty-backed: it
 *    injects ANSI colour and hard-wraps at the pty width, which corrupts exactly
 *    the machine-readable output this module has to parse. So checkers are spawned
 *    directly, with no shell — a project path can't be interpreted as a command.
 * 2. **The project's own checkers, not bundled ones.** `node_modules/typescript`
 *    and `node_modules/eslint` are resolved from the project root, so the report
 *    matches what the user's `npm run typecheck` / `npm run lint` would say. If
 *    the project doesn't have one, it is *skipped and named*, never faked.
 * 3. **Silence never implies health.** {@link DiagnosticsResult.ok} means the
 *    checkers RAN. Nothing installed → `ok: false` and an explicit "nothing was
 *    checked", because "no problems found" from a checker that never started is
 *    the one answer that could make the model ship a broken build.
 *
 * All I/O arrives through {@link DiagnosticsDeps}, so the discovery and honesty
 * rules are unit-tested without spawning anything.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiagnosticEntry, DiagnosticsResult, DiagnosticsScope } from '../../shared/types'
import { normalizePath, parseEslintJson, parseTscOutput, prepareDiagnostics } from './parse'

/** What a checker invocation reported back. Total — spawning never rejects. */
export interface DiagnosticsExecResult {
  /** False when the process could not be started at all. */
  spawned: boolean
  /** Exit code, or null when the process was killed (timeout / cancel). */
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process failed to start, timed out, or was killed. */
  error?: string
}

/** Everything this module touches outside itself, injected so it can be tested. */
export interface DiagnosticsDeps {
  /** Absolute project root the checkers run in. */
  root: string
  /** Runs a node script (absolute path) with `args`, resolving even on failure. */
  exec(script: string, args: string[], signal?: AbortSignal): Promise<DiagnosticsExecResult>
  /** Does this absolute path exist? */
  exists(path: string): boolean
  /** File contents, or null when unreadable. */
  readText(path: string): string | null
}

/** The proposal's parameters, minus the transport fields. */
export interface DiagnosticsRequest {
  scope: DiagnosticsScope
  /** Project-relative paths to narrow the report to; empty = whole project. */
  files?: string[]
  signal?: AbortSignal
}

/** A finished report; the engine only adds `id` and `kind`. */
export type DiagnosticsReport = Omit<DiagnosticsResult, 'id' | 'kind'>

/** Where a checker lives inside a project's `node_modules`. */
const TSC_BIN = ['node_modules', 'typescript', 'bin', 'tsc']
const ESLINT_BIN = ['node_modules', 'eslint', 'bin', 'eslint.js']

/**
 * ESLint config filenames, flat config first (that's what modern projects use and
 * what this repo uses). `eslintConfig` in package.json counts too, so a project
 * with none of these files can still be lintable.
 */
const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc'
]

/**
 * Runs the requested checkers and returns one merged, sorted, capped report.
 *
 * Both checkers run when `scope` is `all`, and a checker that isn't usable is
 * recorded in `skipped` with the reason rather than failing the whole tool —
 * a project with TypeScript but no ESLint should still get its type errors.
 */
export async function runDiagnostics(
  request: DiagnosticsRequest,
  deps: DiagnosticsDeps
): Promise<DiagnosticsReport> {
  const ran: string[] = []
  const skipped: string[] = []
  const raw: DiagnosticEntry[] = []
  const wants = (checker: 'typescript' | 'eslint'): boolean =>
    request.scope === 'all' || request.scope === checker

  if (wants('typescript')) {
    const outcome = await runTypescript(request, deps)
    raw.push(...outcome.entries)
    ran.push(...outcome.ran)
    skipped.push(...outcome.skipped)
  }

  if (wants('eslint')) {
    const outcome = await runEslint(request, deps)
    raw.push(...outcome.entries)
    ran.push(...outcome.ran)
    skipped.push(...outcome.skipped)
  }

  // Narrowing by file happens here rather than in the checkers: tsc cannot
  // meaningfully type-check a subset of a project (a file's errors depend on the
  // whole program), so the full project is checked and the report is filtered.
  const wanted = (request.files ?? []).map(normalizePath).filter((path) => path.length > 0)
  const filtered =
    wanted.length > 0
      ? raw.filter((entry) => entry.file === '' || wanted.some((path) => matchesPath(entry, path)))
      : raw

  const prepared = prepareDiagnostics(filtered)
  const nothingRan = ran.length === 0
  const header: string[] = []
  if (nothingRan) {
    // The "nothing was watching" rule: an empty problem list from a checker that
    // never started must never read as a clean project.
    header.push(
      `NOTHING WAS CHECKED — ${skipped.length > 0 ? skipped.join('; ') : 'no checker was requested'}.`
    )
  } else {
    header.push(`CHECKED: ${ran.join(', ')}`)
    if (skipped.length > 0) header.push(`SKIPPED: ${skipped.join('; ')}`)
    if (wanted.length > 0) header.push(`FILTERED TO: ${wanted.join(', ')}`)
  }

  return {
    ok: !nothingRan,
    entries: prepared.entries,
    errors: prepared.errors,
    warnings: prepared.warnings,
    truncated: prepared.truncated,
    ran,
    skipped,
    output: nothingRan ? header.join('\n') : `${header.join('\n')}\n\n${prepared.output}`,
    summary: nothingRan ? 'nothing was checked' : prepared.summary,
    error: nothingRan
      ? `No checker could be run: ${skipped.length > 0 ? skipped.join('; ') : 'nothing was requested'}`
      : undefined
  }
}

/** One checker's contribution to the merged report. */
interface CheckerOutcome {
  entries: DiagnosticEntry[]
  ran: string[]
  skipped: string[]
}

/**
 * `tsc --noEmit` over every tsconfig the project declares.
 *
 * A solution-style root `tsconfig.json` (`files: []` + `references`) type-checks
 * nothing on its own, so the references are followed and each one is checked —
 * that's the difference between "clean" and actually reading the app's errors.
 * `--composite false` is mandatory: a composite project may not disable emit
 * (TS6304), which would turn the whole check into one config error.
 */
async function runTypescript(
  request: DiagnosticsRequest,
  deps: DiagnosticsDeps
): Promise<CheckerOutcome> {
  const bin = join(deps.root, ...TSC_BIN)
  if (!deps.exists(bin)) {
    return { entries: [], ran: [], skipped: ['typescript (not installed in this project)'] }
  }

  const configs = discoverTsConfigs(deps)
  if (configs.length === 0) {
    return { entries: [], ran: [], skipped: ['typescript (no tsconfig.json found)'] }
  }

  const outcome: CheckerOutcome = { entries: [], ran: [], skipped: [] }
  for (const config of configs) {
    const result = await deps.exec(
      bin,
      ['--noEmit', '--pretty', 'false', '--composite', 'false', '-p', config],
      request.signal
    )
    if (!result.spawned || result.error) {
      outcome.skipped.push(`typescript (${config}: ${result.error ?? 'could not start'})`)
      continue
    }
    // tsc writes diagnostics to stdout; a crash (bad flag, OOM) writes to stderr
    // with no parseable diagnostics, which is a skip, not a clean file.
    const entries = parseTscOutput(`${result.stdout}\n${result.stderr}`)
    if (entries.length === 0 && result.code !== 0) {
      outcome.skipped.push(
        `typescript (${config}: exited ${result.code ?? 'killed'}${firstLine(result.stderr)})`
      )
      continue
    }
    outcome.ran.push(`typescript (${config})`)
    outcome.entries.push(...entries)
  }
  return outcome
}

/**
 * `eslint --format=json` over the project (or the requested files).
 *
 * Exit code 1 means "problems found" — a *successful* run — while 2 means eslint
 * itself failed; the discriminator used here is whether stdout parsed as the JSON
 * report, which is the only signal that can't be misread.
 */
async function runEslint(
  request: DiagnosticsRequest,
  deps: DiagnosticsDeps
): Promise<CheckerOutcome> {
  const bin = join(deps.root, ...ESLINT_BIN)
  if (!deps.exists(bin)) {
    return { entries: [], ran: [], skipped: ['eslint (not installed in this project)'] }
  }
  if (!hasEslintConfig(deps)) {
    return { entries: [], ran: [], skipped: ['eslint (no eslint config in this project)'] }
  }

  const targets = (request.files ?? []).map(normalizePath).filter((path) => path.length > 0)
  const result = await deps.exec(
    bin,
    ['--format', 'json', ...(targets.length > 0 ? targets : ['.'])],
    request.signal
  )
  if (!result.spawned || result.error) {
    return { entries: [], ran: [], skipped: [`eslint (${result.error ?? 'could not start'})`] }
  }

  const entries = parseEslintJson(result.stdout, deps.root)
  if (entries === null) {
    return {
      entries: [],
      ran: [],
      skipped: [`eslint (exited ${result.code ?? 'killed'}${firstLine(result.stderr)})`]
    }
  }
  return { entries, ran: ['eslint'], skipped: [] }
}

/**
 * The tsconfigs worth checking: a solution root's `references` if it has any,
 * otherwise the root config itself. Only paths that exist are returned, so a
 * stale reference degrades to the configs that are really there.
 */
export function discoverTsConfigs(
  deps: Pick<DiagnosticsDeps, 'root' | 'exists' | 'readText'>
): string[] {
  const rootConfig = 'tsconfig.json'
  if (!deps.exists(join(deps.root, rootConfig))) return []

  const text = deps.readText(join(deps.root, rootConfig))
  const references = text ? referencePathsOf(text) : []
  const configs: string[] = []
  for (const reference of references) {
    // A reference may point at a config file or at a directory containing one.
    const direct = reference.endsWith('.json') ? reference : `${reference}/tsconfig.json`
    if (deps.exists(join(deps.root, direct))) configs.push(normalizePath(direct))
  }
  return configs.length > 0 ? configs : [rootConfig]
}

/**
 * Which checkers this project could actually run right now — installed AND
 * configured. Cheap (a handful of `exists` probes, nothing spawned), so a caller
 * can decide whether a diagnostics step is worth proposing at all: asking the
 * user to approve a check that can only answer "nothing was checked" is noise.
 */
export function availableCheckers(
  deps: Pick<DiagnosticsDeps, 'root' | 'exists' | 'readText'>
): { typescript: boolean; eslint: boolean } {
  return {
    typescript:
      deps.exists(join(deps.root, ...TSC_BIN)) && discoverTsConfigs(deps).length > 0,
    eslint: deps.exists(join(deps.root, ...ESLINT_BIN)) && hasEslintConfig(deps)
  }
}

/**
 * The narrowest scope covering everything available, or null when there is
 * nothing to check. Lets a caller run one diagnostics pass instead of one per
 * checker, without ever requesting a checker that would just be skipped.
 */
export function scopeFor(available: { typescript: boolean; eslint: boolean }): DiagnosticsScope | null {
  if (available.typescript && available.eslint) return 'all'
  if (available.typescript) return 'typescript'
  if (available.eslint) return 'eslint'
  return null
}

/**
 * `references: [{ path: … }]` read out of a tsconfig without a JSON parser:
 * tsconfigs are JSONC (comments, trailing commas) and `JSON.parse` chokes on real
 * ones. A regex over the references block is the honest trade — a config it can't
 * read simply yields no references, and the root config is checked instead.
 */
function referencePathsOf(text: string): string[] {
  const block = /"references"\s*:\s*\[([\s\S]*?)\]/.exec(text)
  if (!block) return []
  const paths: string[] = []
  const pathPattern = /"path"\s*:\s*"([^"]+)"/g
  let match = pathPattern.exec(block[1])
  while (match !== null) {
    paths.push(match[1].replace(/^\.\//, ''))
    match = pathPattern.exec(block[1])
  }
  return paths
}

/** True when the project has an eslint config file, or one inside package.json. */
function hasEslintConfig(deps: Pick<DiagnosticsDeps, 'root' | 'exists' | 'readText'>): boolean {
  if (ESLINT_CONFIGS.some((name) => deps.exists(join(deps.root, name)))) return true
  const pkg = deps.readText(join(deps.root, 'package.json'))
  return pkg !== null && /"eslintConfig"\s*:/.test(pkg)
}

/**
 * Does an entry belong to a requested path? A requested *file* matches exactly; a
 * requested *directory* matches everything under it, which is what a model asking
 * for `src/main` means.
 */
function matchesPath(entry: { file: string }, wanted: string): boolean {
  const file = entry.file
  const a = process.platform === 'win32' ? file.toLowerCase() : file
  const b = process.platform === 'win32' ? wanted.toLowerCase() : wanted
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

/** `: message` from a stderr blob, for a one-line skip reason. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0)
  return line ? `: ${line.trim().slice(0, 200)}` : ''
}

/** How long a single checker may run before it's killed. tsc on a cold, large
 * project is genuinely slow, so this is generous; the run's abort signal is the
 * responsive path. */
const CHECKER_TIMEOUT_MS = 180_000

/**
 * The real deps: each checker is run as a **plain node script** via
 * `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. That sidesteps the Windows
 * `.cmd` shims entirely (no shell, no quoting) and needs no node on PATH — the
 * Electron binary already is one. `NO_COLOR`/`FORCE_COLOR=0` keep ANSI escapes out
 * of text that gets parsed.
 */
export function realDiagnosticsDeps(root: string): DiagnosticsDeps {
  return {
    root,
    exists: (path) => existsSync(path),
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    exec: (script, args, signal) =>
      new Promise<DiagnosticsExecResult>((resolveResult) => {
        execFile(
          process.execPath,
          [script, ...args],
          {
            cwd: root,
            signal,
            timeout: CHECKER_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              NO_COLOR: '1',
              FORCE_COLOR: '0'
            }
          },
          (err, stdout, stderr) => {
            const out = String(stdout ?? '')
            const errText = String(stderr ?? '')
            if (!err) {
              resolveResult({ spawned: true, code: 0, stdout: out, stderr: errText })
              return
            }
            // execFile's error carries a numeric `code` for a non-zero exit and
            // `killed` for a timeout/cancel; a spawn failure has neither. A
            // non-zero exit IS a successful run for both checkers — that is how
            // they report problems — so only a kill or a spawn failure is an error.
            const exit = (err as NodeJS.ErrnoException & { code?: number | string }).code
            const killed = (err as { killed?: boolean }).killed === true
            if (typeof exit === 'number' && !killed) {
              resolveResult({ spawned: true, code: exit, stdout: out, stderr: errText })
              return
            }
            resolveResult({
              spawned: killed,
              code: null,
              stdout: out,
              stderr: errText,
              error: killed ? 'timed out or was cancelled' : err.message
            })
          }
        )
      })
  }
}
