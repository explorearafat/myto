import { describe, it, expect } from 'vitest'
import { resolveInterpreter, resolveBash, resolveShell, formatRunResult, executeCode, runCodeTool } from './runCode'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ProviderSettings } from '../../shared/types'

const settingsWith = (codeExecution: boolean): ProviderSettings => ({
  ...DEFAULT_PROVIDER_SETTINGS,
  tools: { ...DEFAULT_PROVIDER_SETTINGS.tools, codeExecution }
})

const gateWith = (codeExecution: boolean) => ({
  settings: settingsWith(codeExecution),
  mode: 'chat' as const,
  workspaceDir: null
})
const ctxOff = { ...gateWith(false), signal: new AbortController().signal }
const ctxOn = { ...gateWith(true), signal: new AbortController().signal }

describe('resolveInterpreter', () => {
  it('maps known languages, case-insensitively', () => {
    expect(resolveInterpreter('python')?.flag).toBe('-c')
    expect(resolveInterpreter('JavaScript')?.electronNode).toBe(true)
    expect(resolveInterpreter('bash')?.flag).toBe('-c')
  })
  it('returns null for unsupported languages', () => {
    expect(resolveInterpreter('ruby')).toBeNull()
  })
  it('routes bash/sh through the real shell resolver', () => {
    // bash/sh no longer come from the static map — they resolve to resolveBash(),
    // which on Windows is the discovered Git Bash rather than a bare (unfound) "bash".
    expect(resolveInterpreter('sh')?.cmd).toBe(resolveBash().cmd)
    expect(resolveInterpreter('bash')?.cmd).toBe(resolveBash().cmd)
  })
})

describe('resolveBash / resolveShell', () => {
  it('resolveBash always runs a bash with -c', () => {
    expect(resolveBash().flag).toBe('-c')
    expect(resolveBash().cmd).toMatch(/bash/i)
  })
  it('resolveShell picks a usable full shell for the platform', () => {
    const s = resolveShell()
    expect(s.cmd).toBeTruthy()
    if (process.platform === 'win32') {
      // Git Bash (-c) when installed, else cmd.exe (/c) — either is a real shell.
      expect(s.flag === '-c' || s.flag === '/c').toBe(true)
    } else {
      expect(s.flag).toBe('-c')
      expect(s.cmd).toMatch(/bash/i)
    }
  })
  it('runs a bash snippet through the resolved shell when bash is available', async () => {
    const r = await executeCode(resolveBash(), 'echo hi from bash', new AbortController().signal)
    // No bash on this machine (e.g. Git for Windows not installed) — nothing to assert.
    if (r.spawnError) return
    expect(r.stdout).toContain('hi from bash')
    expect(r.exitCode).toBe(0)
  }, 20_000)
})

describe('formatRunResult', () => {
  it('reports a spawn error plainly', () => {
    const out = formatRunResult('python', { stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: 'ENOENT' })
    expect(out).toMatch(/Could not run python/)
    expect(out).toMatch(/ENOENT/)
  })
  it('combines stdout, stderr, and exit code', () => {
    const out = formatRunResult('js', { stdout: 'hi\n', stderr: 'warn\n', exitCode: 0, timedOut: false })
    expect(out).toContain('stdout:\nhi')
    expect(out).toContain('stderr:\nwarn')
    expect(out).toContain('exit code: 0')
  })
  it('notes a timeout', () => {
    const out = formatRunResult('bash', { stdout: '', stderr: '', exitCode: null, timedOut: true })
    expect(out).toMatch(/timeout/)
  })
})

describe('runCodeTool gate', () => {
  it('is not available while code execution is off', () => {
    expect(runCodeTool.available(gateWith(false))).toBe(false)
    expect(runCodeTool.available(gateWith(true))).toBe(true)
  })
  it('refuses to run while disabled, without spawning', async () => {
    const out = await runCodeTool.run({ language: 'javascript', code: 'console.log(1)' }, ctxOff)
    expect(out).toMatch(/disabled/i)
    expect(out).toMatch(/Settings/)
  })
  it('rejects a missing language/code when enabled', async () => {
    expect(await runCodeTool.run({ code: 'x' }, ctxOn)).toMatch(/needs a JSON input/)
    expect(await runCodeTool.run({ language: 'python' }, ctxOn)).toMatch(/needs a JSON input/)
  })
  it('rejects an unsupported language when enabled', async () => {
    expect(await runCodeTool.run({ language: 'ruby', code: 'puts 1' }, ctxOn)).toMatch(/does not support/)
  })
})

describe('executeCode (real Node)', () => {
  it('runs a JavaScript snippet and captures stdout', async () => {
    const spec = resolveInterpreter('javascript')!
    const r = await executeCode(spec, 'console.log(2 + 3)', new AbortController().signal)
    expect(r.stdout).toContain('5')
    expect(r.exitCode).toBe(0)
  }, 20_000)

  it('captures a non-zero exit and stderr', async () => {
    const spec = resolveInterpreter('javascript')!
    const r = await executeCode(spec, 'console.error("bad"); process.exit(3)', new AbortController().signal)
    expect(r.stderr).toContain('bad')
    expect(r.exitCode).toBe(3)
  }, 20_000)
})

describe('runCodeTool end-to-end (enabled)', () => {
  it('runs JavaScript and formats the output', async () => {
    const out = await runCodeTool.run({ language: 'javascript', code: 'console.log("hello from node")' }, ctxOn)
    expect(out).toContain('hello from node')
    expect(out).toContain('exit code: 0')
  }, 20_000)
})
