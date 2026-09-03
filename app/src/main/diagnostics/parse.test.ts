import { describe, expect, it } from 'vitest'
import {
  normalizePath,
  parseEslintJson,
  parseTscOutput,
  prepareDiagnostics,
  summaryOf,
  toRelative
} from './parse'

describe('parseTscOutput', () => {
  it('parses a real --pretty false diagnostic', () => {
    const entries = parseTscOutput(
      "src/main/foo.ts(12,3): error TS2345: Argument of type 'x' is not assignable to type 'y'."
    )
    expect(entries).toEqual([
      {
        source: 'typescript',
        severity: 'error',
        file: 'src/main/foo.ts',
        line: 12,
        column: 3,
        code: 'TS2345',
        message: "Argument of type 'x' is not assignable to type 'y'."
      }
    ])
  })

  it('folds indented continuation lines into the message they explain', () => {
    const entries = parseTscOutput(
      [
        "src/a.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.",
        "  Types of property 'id' are incompatible.",
        "    Type 'string' is not assignable to type 'number'."
      ].join('\n')
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe(
      "Type 'A' is not assignable to type 'B'. Types of property 'id' are incompatible. " +
        "Type 'string' is not assignable to type 'number'."
    )
  })

  it('keeps a config-level failure that has no file position', () => {
    const entries = parseTscOutput(
      'error TS18003: No inputs were found in config file "tsconfig.node.json".'
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ file: '', line: 0, column: 0, code: 'TS18003' })
  })

  it('drops the trailing tally line and blank lines', () => {
    const entries = parseTscOutput(
      ['src/a.ts(1,1): error TS1005: expected.', '', 'Found 1 error in src/a.ts:1', ''].join('\n')
    )
    expect(entries).toHaveLength(1)
  })

  it('normalizes windows separators so paths sort and compare', () => {
    const entries = parseTscOutput('src\\main\\a.ts(3,4): error TS1: boom')
    expect(entries[0].file).toBe('src/main/a.ts')
  })

  it('reads a warning as a warning', () => {
    const entries = parseTscOutput('src/a.ts(1,1): warning TS6133: unused.')
    expect(entries[0].severity).toBe('warning')
  })

  it('returns nothing for clean output', () => {
    expect(parseTscOutput('')).toEqual([])
    expect(parseTscOutput('\n\n')).toEqual([])
  })
})

describe('parseEslintJson', () => {
  const report = JSON.stringify([
    {
      filePath: '/project/src/a.ts',
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined.", line: 4, column: 7 },
        { ruleId: 'react-hooks/exhaustive-deps', severity: 1, message: 'deps', line: 9, column: 1 }
      ]
    },
    { filePath: '/project/src/b.ts', messages: [] }
  ])

  it('maps severity 2 to error and 1 to warning, relative to the root', () => {
    const entries = parseEslintJson(report, '/project')
    expect(entries).toEqual([
      {
        source: 'eslint',
        severity: 'error',
        file: 'src/a.ts',
        line: 4,
        column: 7,
        code: 'no-unused-vars',
        message: "'x' is defined."
      },
      {
        source: 'eslint',
        severity: 'warning',
        file: 'src/a.ts',
        line: 9,
        column: 1,
        code: 'react-hooks/exhaustive-deps',
        message: 'deps'
      }
    ])
  })

  it('returns null (not an empty list) when the output is not the JSON report', () => {
    // The whole point: a crashed eslint must never be reported as a clean project.
    expect(parseEslintJson('Oops: config error\n')).toBeNull()
    expect(parseEslintJson('')).toBeNull()
    expect(parseEslintJson('{"not":"an array"}')).toBeNull()
  })

  it('keeps a fatal message that has no rule id or position', () => {
    const entries = parseEslintJson(
      JSON.stringify([
        {
          filePath: '/project/src/a.ts',
          messages: [{ ruleId: null, severity: 2, message: 'Parsing error: unexpected token' }]
        }
      ]),
      '/project'
    )
    expect(entries).toEqual([
      {
        source: 'eslint',
        severity: 'error',
        file: 'src/a.ts',
        line: 0,
        column: 0,
        code: undefined,
        message: 'Parsing error: unexpected token'
      }
    ])
  })

  it('skips malformed entries without losing the good ones', () => {
    const entries = parseEslintJson(
      JSON.stringify([
        null,
        { filePath: 42, messages: [{ severity: 2, message: 'kept' }] },
        { filePath: '/project/src/a.ts', messages: 'nope' }
      ]),
      '/project'
    )
    expect(entries).toEqual([
      {
        source: 'eslint',
        severity: 'error',
        file: '',
        line: 0,
        column: 0,
        code: undefined,
        message: 'kept'
      }
    ])
  })
})

describe('toRelative / normalizePath', () => {
  it('relativizes a path under the root', () => {
    expect(toRelative('/project', '/project/src/a.ts')).toBe('src/a.ts')
  })

  it('tolerates a trailing slash and mixed separators', () => {
    expect(toRelative('C:\\project\\', 'C:/project/src/a.ts')).toBe('src/a.ts')
  })

  it('leaves a path outside the root alone rather than mangling it', () => {
    expect(toRelative('/project', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
  })

  it('strips a leading ./', () => {
    expect(normalizePath('./src/a.ts')).toBe('src/a.ts')
  })
})

describe('prepareDiagnostics', () => {
  const entry = (over: Partial<Parameters<typeof prepareDiagnostics>[0][number]> = {}) => ({
    source: 'typescript' as const,
    severity: 'error' as const,
    file: 'src/a.ts',
    line: 1,
    column: 1,
    code: 'TS1',
    message: 'boom',
    ...over
  })

  it('sorts errors before warnings, then by file and line', () => {
    const prepared = prepareDiagnostics([
      entry({ severity: 'warning', file: 'src/a.ts', line: 2 }),
      entry({ file: 'src/b.ts', line: 1 }),
      entry({ file: 'src/a.ts', line: 9 }),
      entry({ file: 'src/a.ts', line: 4 })
    ])
    expect(prepared.entries.map((e) => `${e.severity} ${e.file}:${e.line}`)).toEqual([
      'error src/a.ts:4',
      'error src/a.ts:9',
      'error src/b.ts:1',
      'warning src/a.ts:2'
    ])
    expect(prepared.errors).toBe(3)
    expect(prepared.warnings).toBe(1)
  })

  it('puts a project-level problem ahead of every file problem', () => {
    const prepared = prepareDiagnostics([
      entry({ file: 'src/a.ts' }),
      entry({ file: '', line: 0, column: 0, code: 'TS18003', message: 'no inputs' })
    ])
    expect(prepared.entries[0].code).toBe('TS18003')
    // A positionless entry renders without a bogus 0:0.
    expect(prepared.output).toContain('(project)\n  error  TS18003  no inputs')
  })

  it('dedupes identical problems reported twice', () => {
    const prepared = prepareDiagnostics([entry(), entry(), entry({ line: 2 })])
    expect(prepared.entries).toHaveLength(2)
    expect(prepared.errors).toBe(2)
  })

  it('groups by file and renders line:col severity code message', () => {
    const prepared = prepareDiagnostics([
      entry({ file: 'src/a.ts', line: 12, column: 3, code: 'TS2345', message: 'bad arg' }),
      entry({
        source: 'eslint',
        severity: 'warning',
        file: 'src/a.ts',
        line: 40,
        column: 1,
        code: 'no-unused-vars',
        message: "'y' unused"
      })
    ])
    expect(prepared.output).toBe(
      [
        'src/a.ts',
        '  12:3  error  TS2345  bad arg',
        "  40:1  warning  no-unused-vars  'y' unused",
        '',
        '1 error, 1 warning'
      ].join('\n')
    )
  })

  it('caps the list and says so, keeping the REAL total in the counts', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry({ line: i + 1 }))
    const prepared = prepareDiagnostics(many, { maxEntries: 5 })
    expect(prepared.entries).toHaveLength(5)
    expect(prepared.errors).toBe(12)
    expect(prepared.truncated).toBe(true)
    expect(prepared.output).toContain('showing the first 5 of 12')
  })

  it('applies the character cap as a second pass', () => {
    const long = Array.from({ length: 6 }, (_, i) =>
      entry({ line: i + 1, message: 'x'.repeat(400) })
    )
    const prepared = prepareDiagnostics(long, { maxChars: 900 })
    expect(prepared.truncated).toBe(true)
    expect(prepared.output.length).toBeLessThanOrEqual(900)
    expect(prepared.entries.length).toBeLessThan(6)
  })

  it('reports a clean list honestly', () => {
    const prepared = prepareDiagnostics([])
    expect(prepared.summary).toBe('clean')
    expect(prepared.output).toBe('No problems reported.')
    expect(prepared.truncated).toBe(false)
  })
})

describe('summaryOf', () => {
  it('pluralizes and omits empty halves', () => {
    expect(summaryOf(1, 0)).toBe('1 error')
    expect(summaryOf(0, 1)).toBe('1 warning')
    expect(summaryOf(3, 2)).toBe('3 errors, 2 warnings')
    expect(summaryOf(0, 0)).toBe('clean')
  })
})
