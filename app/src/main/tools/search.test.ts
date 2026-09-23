import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchCodeTool, findFilesTool, globToRegExp } from './search'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ToolContext, ToolGate } from './registry'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'myto-search-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'src', 'app.ts'), 'export function handleLogin() {\n  return true\n}\n')
  await writeFile(join(dir, 'src', 'util.ts'), 'export const noop = () => {}\n')
  await writeFile(join(dir, 'README.md'), '# handleLogin lives in src/app.ts\n')
  // Something that must be skipped: a match inside node_modules.
  await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'function handleLogin(){}\n')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const gate = (over: Partial<ToolGate> = {}): ToolGate => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir: dir,
  ...over
})
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  ...gate(),
  signal: new AbortController().signal,
  ...over
})

describe('globToRegExp', () => {
  it('matches globs anchored, wildcards spanning a segment', () => {
    expect(globToRegExp('*.ts').test('app.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('app.tsx')).toBe(false)
    expect(globToRegExp('app.?s').test('app.ts')).toBe(true)
  })
  it('treats a plain string as a contains-match', () => {
    expect(globToRegExp('SignUp').test('SignUp.jsx')).toBe(true)
    expect(globToRegExp('login').test('handleLogin')).toBe(true) // case-insensitive
  })
})

describe('searchCodeTool', () => {
  it('is available only in cowork with a folder', () => {
    expect(searchCodeTool.available(gate())).toBe(true)
    expect(searchCodeTool.available(gate({ mode: 'chat' }))).toBe(false)
    expect(searchCodeTool.available(gate({ workspaceDir: null }))).toBe(false)
  })
  it('is read-only', () => {
    expect(searchCodeTool.sideEffect).toBeUndefined()
  })
  it('finds matches as file:line and skips node_modules', async () => {
    const out = await searchCodeTool.run({ query: 'handleLogin' }, ctx())
    expect(out).toMatch(/src\/app\.ts:1:/)
    expect(out).toMatch(/README\.md:1:/)
    expect(out).not.toMatch(/node_modules/)
  })
  it('honours a glob filter', async () => {
    const out = await searchCodeTool.run({ query: 'handleLogin', glob: '*.md' }, ctx())
    expect(out).toMatch(/README\.md:\d/)
    // The .ts files are filtered out — no file:line match for them (the README's
    // prose mentioning "src/app.ts" is not a match location).
    expect(out).not.toMatch(/app\.ts:\d/)
  })
  it('reports no matches cleanly', async () => {
    expect(await searchCodeTool.run({ query: 'zzz-not-here' }, ctx())).toMatch(/No matches/i)
  })
  it('needs a query', async () => {
    expect(await searchCodeTool.run({}, ctx())).toMatch(/needs a "query"/i)
  })
})

describe('findFilesTool', () => {
  it('matches files by glob', async () => {
    const out = await findFilesTool.run({ pattern: '*.ts' }, ctx())
    expect(out).toMatch(/src\/app\.ts/)
    expect(out).toMatch(/src\/util\.ts/)
    expect(out).not.toMatch(/README\.md/)
  })
  it('matches a bare substring against the path', async () => {
    const out = await findFilesTool.run({ pattern: 'app' }, ctx())
    expect(out).toMatch(/src\/app\.ts/)
  })
  it('needs a pattern', async () => {
    expect(await findFilesTool.run({}, ctx())).toMatch(/needs a "pattern"/i)
  })
})
