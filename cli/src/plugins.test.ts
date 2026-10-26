import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPlugins, pluginDirs, pluginTemplate, savePlugin, validatePlugin } from './plugins'

const makeTemp = (): string => mkdtempSync(join(tmpdir(), 'myto-plugins-'))
const cleanup = (dirs: string[]): void => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))

describe('validatePlugin', () => {
  it('accepts a valid prompt plugin', () => {
    const v = validatePlugin({ name: 'weekly-digest', title: 'Weekly digest', kind: 'prompt', prompt: 'Summarize the week.' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.plugin.title).toBe('Weekly digest')
  })
  it('accepts a valid command plugin', () => {
    const v = validatePlugin({ name: 'lint', title: 'Lint', kind: 'command', command: 'npm run lint' })
    expect(v.ok).toBe(true)
  })
  it('rejects bad shapes with a human reason', () => {
    expect(validatePlugin(null).ok).toBe(false)
    expect(validatePlugin([1]).ok).toBe(false)
    expect(validatePlugin({ title: 'x', kind: 'prompt', prompt: 'y' }).ok).toBe(false) // no name
    expect(validatePlugin({ name: 'BAD NAME', title: 'x', kind: 'prompt', prompt: 'y' }).ok).toBe(false)
    expect(validatePlugin({ name: 'a', title: '', kind: 'prompt', prompt: 'y' }).ok).toBe(false)
    expect(validatePlugin({ name: 'a', title: 'x', kind: 'mystery' }).ok).toBe(false)
    expect(validatePlugin({ name: 'a', title: 'x', kind: 'prompt' }).ok).toBe(false) // no prompt
    expect(validatePlugin({ name: 'a', title: 'x', kind: 'command' }).ok).toBe(false) // no command
  })
})

describe('listPlugins', () => {
  it('discovers manifests from both directories and dedupes by name', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const wsDir = pluginDirs(ws, home)[0].dir
      const userDir = pluginDirs(ws, home)[1].dir
      mkdirSync(wsDir, { recursive: true })
      mkdirSync(userDir, { recursive: true })
      writeFileSync(join(wsDir, 'a.json'), JSON.stringify({ name: 'a', title: 'A', kind: 'prompt', prompt: 'do a' }))
      writeFileSync(join(userDir, 'a.json'), JSON.stringify({ name: 'a', title: 'A (user)', kind: 'prompt', prompt: 'do a' }))
      writeFileSync(join(userDir, 'b.json'), JSON.stringify({ name: 'b', title: 'B', kind: 'command', command: 'echo b' }))
      const scan = listPlugins(ws, home)
      expect(scan.errors).toEqual([])
      expect(scan.plugins.map((p) => p.name)).toEqual(['a', 'b'])
      expect(scan.plugins[0].title).toBe('A')
      expect(scan.plugins[1].kind).toBe('command')
    } finally {
      cleanup([ws, home])
    }
  })
  it('reports broken JSON and invalid manifests per file', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const dir = pluginDirs(ws, home)[0].dir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'torn.json'), '{ oops')
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ name: 'x' }))
      const scan = listPlugins(ws, home)
      expect(scan.plugins).toEqual([])
      expect(scan.errors).toHaveLength(2)
    } finally {
      cleanup([ws, home])
    }
  })
  it('returns empty when no directories exist', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const scan = listPlugins(ws, home)
      expect(scan.plugins).toEqual([])
      expect(scan.errors).toEqual([])
    } finally {
      cleanup([ws, home])
    }
  })
})

describe('savePlugin + template', () => {
  it('writes a manifest that round-trips validation', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const path = savePlugin(ws, 'digest', pluginTemplate('digest', 'Weekly digest'), 'user', home)
      expect(path.startsWith(home)).toBe(true)
      expect(path.endsWith('digest.json')).toBe(true)
      const scan = listPlugins(ws, home)
      expect(scan.errors).toEqual([])
      expect(scan.plugins).toHaveLength(1)
      expect(scan.plugins[0].name).toBe('digest')
    } finally {
      cleanup([ws, home])
    }
  })
})
