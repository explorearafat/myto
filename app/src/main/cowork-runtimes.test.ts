import { describe, expect, it } from 'vitest'
import {
  buildRuntimeReport,
  parseUsableVersion,
  runtimeCandidates,
  summarizeRuntimes,
  type RuntimeReport
} from './cowork-runtimes'

describe('parseUsableVersion', () => {
  it('parses a plain version line', () => {
    expect(parseUsableVersion('Python 3.14.6')).toBe('3.14.6')
  })

  it('strips a leading v (node)', () => {
    expect(parseUsableVersion('v24.18.0')).toBe('24.18.0')
  })

  it('parses a two-part version', () => {
    expect(parseUsableVersion('pip 26.1 from C:\\x')).toBe('26.1')
  })

  it('rejects the Windows Store python alias stub', () => {
    const stub =
      'Python was not found; run without arguments to install from the Microsoft Store, ' +
      'or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.'
    expect(parseUsableVersion(stub)).toBeNull()
  })

  it('rejects "command not found" (bash)', () => {
    expect(parseUsableVersion('bash: blender: command not found')).toBeNull()
  })

  it('rejects "is not recognized" (cmd)', () => {
    expect(parseUsableVersion("'blender' is not recognized as an internal or external command")).toBeNull()
  })

  it('is null for empty output', () => {
    expect(parseUsableVersion('')).toBeNull()
  })
})

describe('runtimeCandidates', () => {
  it('prefers py and soffice on win32', () => {
    const c = runtimeCandidates('win32')
    expect(c.python).toEqual(['py', 'python'])
    expect(c.libreoffice).toEqual(['soffice', 'libreoffice'])
  })

  it('prefers python3 and libreoffice on posix', () => {
    const c = runtimeCandidates('linux')
    expect(c.python).toEqual(['python3', 'python'])
    expect(c.libreoffice).toEqual(['libreoffice', 'soffice'])
  })
})

describe('buildRuntimeReport', () => {
  const candidates = runtimeCandidates('win32')

  it('takes the first candidate that yields a version', () => {
    const report = buildRuntimeReport(candidates, { py: 'Python 3.14.6', python: 'Python 3.14.6' })
    expect(report.python).toEqual({ command: 'py', version: '3.14.6' })
  })

  it('falls through the store-alias stub to the next working candidate', () => {
    const report = buildRuntimeReport(candidates, {
      py: 'Python was not found; install from the Microsoft Store — App execution aliases.',
      python: 'Python 3.14.6'
    })
    expect(report.python).toEqual({ command: 'python', version: '3.14.6' })
  })

  it('reports a runtime as absent when no candidate produced output', () => {
    const report = buildRuntimeReport(candidates, { node: 'v24.18.0' })
    expect(report.node).toEqual({ command: 'node', version: '24.18.0' })
    expect(report.blender).toBeNull()
    expect(report.libreoffice).toBeNull()
  })

  it('mirrors this machine: python/node/npm/pip present, blender+libreoffice absent', () => {
    const report = buildRuntimeReport(candidates, {
      py: 'Python 3.14.6',
      node: 'v24.18.0',
      npm: '11.16.0',
      pip: 'pip 26.1.2 from C:\\x (python 3.14)',
      soffice: "'soffice' is not recognized as an internal or external command",
      blender: "'blender' is not recognized as an internal or external command"
    })
    expect(report.python?.command).toBe('py')
    expect(report.node?.version).toBe('24.18.0')
    expect(report.npm?.version).toBe('11.16.0')
    expect(report.pip?.version).toBe('26.1.2')
    expect(report.blender).toBeNull()
    expect(report.libreoffice).toBeNull()
  })
})

describe('summarizeRuntimes', () => {
  const present: RuntimeReport = {
    python: { command: 'py', version: '3.14.6' },
    pip: { command: 'pip', version: '26.1.2' },
    node: { command: 'node', version: '24.18.0' },
    npm: { command: 'npm', version: '11.16.0' },
    blender: null,
    libreoffice: null
  }

  it('gives the detected python command in the install hint (never python3)', () => {
    const s = summarizeRuntimes(present)
    expect(s).toContain('py -m pip install')
    expect(s).not.toContain('python3')
  })

  it('names the scripting libraries for present runtimes', () => {
    const s = summarizeRuntimes(present)
    expect(s).toContain('openpyxl')
    expect(s).toContain('pptxgenjs')
  })

  it('lists absent runtimes as not found', () => {
    const s = summarizeRuntimes(present)
    expect(s).toContain('Blender: not found')
    expect(s).toContain('LibreOffice: not found')
  })

  it('tells the model to script, not open a GUI or paste contents', () => {
    const s = summarizeRuntimes(present)
    expect(s).toContain('not by opening a GUI app')
    expect(s).toContain('not by pasting file contents')
  })
})
