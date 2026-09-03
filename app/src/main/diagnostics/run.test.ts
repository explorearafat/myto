import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  availableCheckers,
  discoverTsConfigs,
  runDiagnostics,
  scopeFor,
  type DiagnosticsDeps,
  type DiagnosticsExecResult
} from './run'

const ROOT = join('/project')

/** A recorded invocation, so tests can assert the exact flags each checker gets. */
interface Call {
  script: string
  args: string[]
}

/**
 * A fake project: `files` decides what exists and what a read returns, and
 * `respond` decides what each checker prints. Nothing is spawned.
 */
function makeDeps(
  files: Record<string, string>,
  respond: (call: Call) => Partial<DiagnosticsExecResult>
): { deps: DiagnosticsDeps; calls: Call[] } {
  const calls: Call[] = []
  const has = (path: string): boolean =>
    Object.keys(files).some((name) => join(ROOT, name) === path)
  return {
    calls,
    deps: {
      root: ROOT,
      exists: has,
      readText: (path) => {
        const hit = Object.keys(files).find((name) => join(ROOT, name) === path)
        return hit === undefined ? null : files[hit]
      },
      exec: async (script, args) => {
        const call = { script, args }
        calls.push(call)
        return { spawned: true, code: 0, stdout: '', stderr: '', ...respond(call) }
      }
    }
  }
}

/** A project with both checkers installed and a solution-style root tsconfig. */
const FULL_PROJECT: Record<string, string> = {
  'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }] }',
  'tsconfig.node.json': '{}',
  'eslint.config.js': 'export default []',
  'node_modules/typescript/bin/tsc': '',
  'node_modules/eslint/bin/eslint.js': ''
}

const isTsc = (call: Call): boolean => call.script.includes('typescript')
const isEslint = (call: Call): boolean => call.script.includes('eslint')

describe('runDiagnostics — what actually ran', () => {
  it('runs both checkers and merges their problems', async () => {
    const { deps, calls } = makeDeps(FULL_PROJECT, (call) =>
      isTsc(call)
        ? { code: 1, stdout: 'src/a.ts(3,4): error TS2345: bad arg' }
        : {
            code: 1,
            stdout: JSON.stringify([
              {
                filePath: join(ROOT, 'src/b.ts'),
                messages: [{ ruleId: 'no-x', severity: 1, message: 'meh', line: 2, column: 1 }]
              }
            ])
          }
    )
    const report = await runDiagnostics({ scope: 'all' }, deps)

    expect(report.ok).toBe(true)
    expect(report.ran).toEqual(['typescript (tsconfig.node.json)', 'eslint'])
    expect(report.skipped).toEqual([])
    expect(report.errors).toBe(1)
    expect(report.warnings).toBe(1)
    expect(report.summary).toBe('1 error, 1 warning')
    expect(report.output).toContain('CHECKED: typescript (tsconfig.node.json), eslint')
    expect(report.output).toContain('src/a.ts')
    expect(report.output).toContain('src/b.ts')
    expect(calls).toHaveLength(2)
  })

  it('passes the flags that make the output parseable', async () => {
    const { deps, calls } = makeDeps(FULL_PROJECT, () => ({ stdout: '[]' }))
    await runDiagnostics({ scope: 'all' }, deps)

    const tsc = calls.find(isTsc)
    // --pretty false keeps ANSI out of the text we parse; --composite false is
    // mandatory (a composite project may not disable emit → TS6304).
    expect(tsc?.args).toEqual([
      '--noEmit',
      '--pretty',
      'false',
      '--composite',
      'false',
      '-p',
      'tsconfig.node.json'
    ])
    expect(calls.find(isEslint)?.args).toEqual(['--format', 'json', '.'])
  })

  it('honours a narrowed scope', async () => {
    const { deps, calls } = makeDeps(FULL_PROJECT, () => ({ stdout: '' }))
    const report = await runDiagnostics({ scope: 'typescript' }, deps)
    expect(calls.every(isTsc)).toBe(true)
    expect(report.ran).toEqual(['typescript (tsconfig.node.json)'])
    expect(report.skipped).toEqual([])
  })

  it('checks every referenced project of a solution-style root config', async () => {
    const files = {
      ...FULL_PROJECT,
      'tsconfig.json':
        '{ "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }',
      'tsconfig.web.json': '{}'
    }
    const { deps, calls } = makeDeps(files, () => ({ stdout: '' }))
    const report = await runDiagnostics({ scope: 'typescript' }, deps)
    expect(calls.map((c) => c.args[c.args.length - 1])).toEqual([
      'tsconfig.node.json',
      'tsconfig.web.json'
    ])
    expect(report.ran).toEqual([
      'typescript (tsconfig.node.json)',
      'typescript (tsconfig.web.json)'
    ])
  })
})

describe('runDiagnostics — silence never implies health', () => {
  it('is NOT ok when no checker is installed, and says nothing was checked', async () => {
    const { deps, calls } = makeDeps({ 'tsconfig.json': '{}' }, () => ({}))
    const report = await runDiagnostics({ scope: 'all' }, deps)

    expect(calls).toHaveLength(0)
    expect(report.ok).toBe(false)
    expect(report.summary).toBe('nothing was checked')
    expect(report.output).toContain('NOTHING WAS CHECKED')
    expect(report.output).toContain('typescript (not installed in this project)')
    expect(report.output).toContain('eslint (not installed in this project)')
    // The one thing this must never say.
    expect(report.output).not.toContain('No problems reported.')
    expect(report.error).toContain('No checker could be run')
  })

  it('treats a crashed eslint as skipped, not as a clean project', async () => {
    const { deps } = makeDeps(FULL_PROJECT, (call) =>
      isEslint(call)
        ? { code: 2, stdout: '', stderr: 'Error: Failed to load config\n  at …' }
        : { stdout: '' }
    )
    const report = await runDiagnostics({ scope: 'all' }, deps)

    // TypeScript still ran, so the report is still useful — but eslint is named.
    expect(report.ok).toBe(true)
    expect(report.ran).toEqual(['typescript (tsconfig.node.json)'])
    expect(report.skipped).toEqual(['eslint (exited 2: Error: Failed to load config)'])
    expect(report.output).toContain('SKIPPED: eslint (exited 2')
  })

  it('treats a crashed tsc (no parseable diagnostics, non-zero exit) as skipped', async () => {
    const { deps } = makeDeps(FULL_PROJECT, (call) =>
      isTsc(call) ? { code: 1, stderr: 'Cannot find module typescript' } : { stdout: '[]' }
    )
    const report = await runDiagnostics({ scope: 'typescript' }, deps)
    expect(report.ok).toBe(false)
    expect(report.skipped[0]).toContain('Cannot find module typescript')
  })

  it('reports a cancelled/timed-out checker as skipped', async () => {
    const { deps } = makeDeps(FULL_PROJECT, () => ({
      spawned: true,
      code: null,
      error: 'timed out or was cancelled'
    }))
    const report = await runDiagnostics({ scope: 'all' }, deps)
    expect(report.ok).toBe(false)
    expect(report.skipped).toEqual([
      'typescript (tsconfig.node.json: timed out or was cancelled)',
      'eslint (timed out or was cancelled)'
    ])
  })

  it('skips eslint when the project has no eslint config', async () => {
    const files = { ...FULL_PROJECT }
    delete files['eslint.config.js']
    const { deps, calls } = makeDeps(files, () => ({ stdout: '' }))
    const report = await runDiagnostics({ scope: 'all' }, deps)
    expect(calls.some(isEslint)).toBe(false)
    expect(report.skipped).toEqual(['eslint (no eslint config in this project)'])
  })

  it('accepts an eslintConfig block in package.json as a config', async () => {
    // Annotated: spreading in a literal key would otherwise drop the index
    // signature and make the `delete` below an implicit-any index.
    const files: Record<string, string> = {
      ...FULL_PROJECT,
      'package.json': '{ "eslintConfig": { "root": true } }'
    }
    delete files['eslint.config.js']
    const { deps, calls } = makeDeps(files, () => ({ stdout: '[]' }))
    const report = await runDiagnostics({ scope: 'eslint' }, deps)
    expect(calls.some(isEslint)).toBe(true)
    expect(report.ran).toEqual(['eslint'])
  })

  it('skips typescript when the project has no tsconfig', async () => {
    const files = { ...FULL_PROJECT }
    delete files['tsconfig.json']
    delete files['tsconfig.node.json']
    const { deps } = makeDeps(files, () => ({ stdout: '[]' }))
    const report = await runDiagnostics({ scope: 'typescript' }, deps)
    expect(report.skipped).toEqual(['typescript (no tsconfig.json found)'])
    expect(report.ok).toBe(false)
  })

  it('reports a clean run as ok with zero counts', async () => {
    const { deps } = makeDeps(FULL_PROJECT, (call) =>
      isTsc(call) ? { code: 0, stdout: '' } : { code: 0, stdout: '[]' }
    )
    const report = await runDiagnostics({ scope: 'all' }, deps)
    expect(report.ok).toBe(true)
    expect(report.summary).toBe('clean')
    expect(report.output).toContain('CHECKED:')
    expect(report.output).toContain('No problems reported.')
  })
})

describe('runDiagnostics — narrowing by file', () => {
  const stdout = [
    'src/main/a.ts(1,1): error TS1: a',
    'src/renderer/b.ts(2,2): error TS2: b',
    'error TS18003: no inputs'
  ].join('\n')

  it('filters the report to the requested paths but still checks the whole program', async () => {
    const { deps, calls } = makeDeps(FULL_PROJECT, (call) =>
      isTsc(call) ? { code: 1, stdout } : { code: 0, stdout: '[]' }
    )
    const report = await runDiagnostics({ scope: 'typescript', files: ['src/main/a.ts'] }, deps)

    // tsc was still given the whole project — a file's errors depend on the rest.
    expect(calls.find(isTsc)?.args).toContain('tsconfig.node.json')
    expect(report.entries.map((e) => e.file)).toEqual(['', 'src/main/a.ts'])
    expect(report.output).toContain('FILTERED TO: src/main/a.ts')
  })

  it('treats a requested folder as everything under it', async () => {
    const { deps } = makeDeps(FULL_PROJECT, (call) =>
      isTsc(call) ? { code: 1, stdout } : { code: 0, stdout: '[]' }
    )
    const report = await runDiagnostics({ scope: 'typescript', files: ['src/renderer'] }, deps)
    expect(report.entries.map((e) => e.file)).toEqual(['', 'src/renderer/b.ts'])
  })

  it('keeps a project-level problem no matter what was requested', async () => {
    const { deps } = makeDeps(FULL_PROJECT, (call) =>
      isTsc(call) ? { code: 1, stdout } : { code: 0, stdout: '[]' }
    )
    const report = await runDiagnostics({ scope: 'typescript', files: ['nothing/here.ts'] }, deps)
    // A compiler that refused to start outranks the filter.
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].code).toBe('TS18003')
  })

  it('passes requested paths to eslint as its targets', async () => {
    const { deps, calls } = makeDeps(FULL_PROJECT, () => ({ code: 0, stdout: '[]' }))
    await runDiagnostics({ scope: 'eslint', files: ['src/a.ts', 'src/b.ts'] }, deps)
    expect(calls.find(isEslint)?.args).toEqual(['--format', 'json', 'src/a.ts', 'src/b.ts'])
  })
})

describe('discoverTsConfigs', () => {
  const depsFor = (files: Record<string, string>): Pick<DiagnosticsDeps, 'root' | 'exists' | 'readText'> => ({
    root: ROOT,
    exists: (path) => Object.keys(files).some((name) => join(ROOT, name) === path),
    readText: (path) => {
      const hit = Object.keys(files).find((name) => join(ROOT, name) === path)
      return hit === undefined ? null : files[hit]
    }
  })

  it('returns nothing when there is no tsconfig at all', () => {
    expect(discoverTsConfigs(depsFor({}))).toEqual([])
  })

  it('falls back to the root config when it has no references', () => {
    expect(discoverTsConfigs(depsFor({ 'tsconfig.json': '{ "compilerOptions": {} }' }))).toEqual([
      'tsconfig.json'
    ])
  })

  it('tolerates comments and trailing commas (tsconfigs are JSONC)', () => {
    const files = {
      'tsconfig.json': `{
        // the app is split in two programs
        "files": [],
        "references": [{ "path": "./tsconfig.node.json" },],
      }`,
      'tsconfig.node.json': '{}'
    }
    expect(discoverTsConfigs(depsFor(files))).toEqual(['tsconfig.node.json'])
  })

  it('resolves a reference that points at a directory', () => {
    const files = {
      'tsconfig.json': '{ "references": [{ "path": "./packages/app" }] }',
      'packages/app/tsconfig.json': '{}'
    }
    expect(discoverTsConfigs(depsFor(files))).toEqual(['packages/app/tsconfig.json'])
  })

  it('ignores a stale reference and falls back to the root config', () => {
    const files = { 'tsconfig.json': '{ "references": [{ "path": "./gone.json" }] }' }
    expect(discoverTsConfigs(depsFor(files))).toEqual(['tsconfig.json'])
  })
})

describe('availableCheckers / scopeFor', () => {
  const depsFor = (files: Record<string, string>): Pick<DiagnosticsDeps, 'root' | 'exists' | 'readText'> => ({
    root: ROOT,
    exists: (path) => Object.keys(files).some((name) => join(ROOT, name) === path),
    readText: (path) => {
      const hit = Object.keys(files).find((name) => join(ROOT, name) === path)
      return hit === undefined ? null : files[hit]
    }
  })

  it('reports both when both are installed and configured', () => {
    expect(availableCheckers(depsFor(FULL_PROJECT))).toEqual({ typescript: true, eslint: true })
  })

  it('needs a config, not just the binary', () => {
    // Installed but unusable is NOT available — proposing it would only produce
    // "nothing was checked".
    const noConfigs: Record<string, string> = {
      'node_modules/typescript/bin/tsc': '',
      'node_modules/eslint/bin/eslint.js': ''
    }
    expect(availableCheckers(depsFor(noConfigs))).toEqual({ typescript: false, eslint: false })
  })

  it('needs the binary, not just the config', () => {
    const noBins: Record<string, string> = {
      'tsconfig.json': '{}',
      'eslint.config.js': 'export default []'
    }
    expect(availableCheckers(depsFor(noBins))).toEqual({ typescript: false, eslint: false })
  })

  it('picks the narrowest scope that covers what is available', () => {
    expect(scopeFor({ typescript: true, eslint: true })).toBe('all')
    expect(scopeFor({ typescript: true, eslint: false })).toBe('typescript')
    expect(scopeFor({ typescript: false, eslint: true })).toBe('eslint')
    // Null, not 'all': there is nothing to ask for.
    expect(scopeFor({ typescript: false, eslint: false })).toBeNull()
  })
})
