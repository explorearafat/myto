import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { previewTool } from './preview'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { PreviewTarget } from '../../shared/types'
import type { ToolContext } from './registry'

// A real temp folder stands in for the Cowork workspace.
const ROOT = mkdtempSync(join(tmpdir(), 'myto-preview-test-'))

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/** A cowork ToolContext with a spy onPreview, scoped to the temp workspace. */
function ctx(
  workspaceDir: string | null = ROOT
): ToolContext & { previews: PreviewTarget[] } {
  const previews: PreviewTarget[] = []
  return {
    settings: DEFAULT_PROVIDER_SETTINGS,
    mode: 'cowork',
    workspaceDir,
    signal: new AbortController().signal,
    onPreview: (t) => previews.push(t),
    previews
  }
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

describe('previewTool.available', () => {
  const base = { settings: DEFAULT_PROVIDER_SETTINGS }
  it('is available in cowork, not in chat', () => {
    expect(previewTool.available({ ...base, mode: 'cowork', workspaceDir: ROOT })).toBe(true)
    // A URL preview needs no folder, so cowork-with-no-folder is still available.
    expect(previewTool.available({ ...base, mode: 'cowork', workspaceDir: null })).toBe(true)
    expect(previewTool.available({ ...base, mode: 'chat', workspaceDir: ROOT })).toBe(false)
  })

  it('is read-only (no sideEffect, never needs approval)', () => {
    expect(previewTool.sideEffect).toBeUndefined()
  })
})

describe('previewTool.run — files', () => {
  it('opens an existing working-folder file as a file:// target', async () => {
    writeFileSync(join(ROOT, 'report.html'), '<h1>hi</h1>')
    const c = ctx()
    const msg = await previewTool.run({ path: 'report.html' }, c)
    expect(c.previews).toHaveLength(1)
    expect(c.previews[0]).toEqual({
      kind: 'file',
      url: pathToFileURL(join(ROOT, 'report.html')).toString(),
      title: 'report.html'
    })
    expect(msg).toContain('report.html')
  })

  it('refuses a file outside the workspace', async () => {
    const c = ctx()
    const msg = await previewTool.run({ path: '../secret.txt' }, c)
    expect(c.previews).toHaveLength(0)
    expect(msg).toMatch(/outside the working folder/i)
  })

  it('refuses a file that does not exist yet', async () => {
    const c = ctx()
    const msg = await previewTool.run({ path: 'missing.pdf' }, c)
    expect(c.previews).toHaveLength(0)
    expect(msg).toMatch(/does not exist/i)
  })

  it('refuses a directory (not a file)', async () => {
    mkdirSync(join(ROOT, 'sub'))
    const c = ctx()
    const msg = await previewTool.run({ path: 'sub' }, c)
    expect(c.previews).toHaveLength(0)
    expect(msg).toMatch(/not a file/i)
  })

  it('explains when a path is given but no folder is set', async () => {
    const c = ctx(null)
    const msg = await previewTool.run({ path: 'report.html' }, c)
    expect(c.previews).toHaveLength(0)
    expect(msg).toMatch(/no working folder/i)
  })
})

describe('previewTool.run — urls', () => {
  it('opens an http(s) url as a url target', async () => {
    const c = ctx()
    const msg = await previewTool.run({ url: 'http://localhost:5173' }, c)
    expect(c.previews).toHaveLength(1)
    expect(c.previews[0]).toMatchObject({ kind: 'url', title: 'http://localhost:5173' })
    expect(c.previews[0].url).toContain('localhost:5173')
    expect(msg).toContain('localhost:5173')
  })

  it('refuses a non-http protocol', async () => {
    const c = ctx()
    const msg = await previewTool.run({ url: 'ftp://example.com' }, c)
    expect(c.previews).toHaveLength(0)
    expect(msg).toMatch(/only http/i)
  })

  it('refuses a malformed url', async () => {
    const c = ctx()
    const msg = await previewTool.run({ url: 'not a url' }, c)
    expect(c.previews).toHaveLength(0)
    expect(msg).toMatch(/not a valid url/i)
  })
})

describe('previewTool.run — misc', () => {
  it('asks for a path or url when neither is given', async () => {
    const c = ctx()
    const msg = await previewTool.run({}, c)
    expect(c.previews).toHaveLength(0)
    expect(msg).toMatch(/needs a "path".*"url"/is)
  })

  it('degrades to a note when there is no preview pane (no onPreview)', async () => {
    writeFileSync(join(ROOT, 'a.html'), 'x')
    const noPane = {
      settings: DEFAULT_PROVIDER_SETTINGS,
      mode: 'cowork' as const,
      workspaceDir: ROOT,
      signal: new AbortController().signal
    }
    const msg = await previewTool.run({ path: 'a.html' }, noPane)
    expect(msg).toMatch(/not available/i)
  })

  it('prefers a url when both url and path are present', async () => {
    const spy = vi.fn()
    const c: ToolContext = {
      settings: DEFAULT_PROVIDER_SETTINGS,
      mode: 'cowork',
      workspaceDir: ROOT,
      signal: new AbortController().signal,
      onPreview: spy
    }
    await previewTool.run({ url: 'https://example.com', path: 'report.html' }, c)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ kind: 'url' })
  })
})
