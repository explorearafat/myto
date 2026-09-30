import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderDocumentTool } from './document-raster'
import type { ToolContext } from './registry'
import type { ChatImage } from '../../shared/types'

/**
 * render_document behaviour without Electron: rasterization is a ctx callback
 * ({@link ToolContext.rasterizeDocument}), so a fake stands in for the offscreen renderer and
 * the tool's routing, vision-channel, and degraded paths are all exercised here.
 */

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'myto-raster-'))
  await writeFile(join(dir, 'scan.pdf'), Buffer.from('%PDF-1.4 fake'))
  await writeFile(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(dir, 'notes.txt'), 'hello')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Build a ToolContext with the working folder set and optional overrides. */
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    settings: {} as ToolContext['settings'],
    mode: 'cowork',
    workspaceDir: dir,
    signal: new AbortController().signal,
    ...over
  }
}

describe('render_document', () => {
  it('asks for a path when none is given', async () => {
    const out = await renderDocumentTool.run({}, ctx())
    expect(out).toMatch(/needs \{"path"/)
  })

  it('refuses a path outside the working folder', async () => {
    const out = await renderDocumentTool.run({ path: '../secret.pdf' }, ctx())
    expect(out).toMatch(/outside the working folder/i)
  })

  it('declines a non-PDF, non-image file', async () => {
    const out = await renderDocumentTool.run({ path: 'notes.txt' }, ctx())
    expect(out).toMatch(/read_document/)
  })

  it('reports the runtime is missing when rasterizeDocument is not wired', async () => {
    const out = await renderDocumentTool.run({ path: 'scan.pdf' }, ctx())
    expect(out).toMatch(/needs the app runtime/i)
  })

  it('rasterizes a PDF and hands the pages to the vision channel', async () => {
    const emitted: { images: ChatImage[]; caption?: string }[] = []
    const out = await renderDocumentTool.run(
      { path: 'scan.pdf', pages: '1-2' },
      ctx({
        rasterizeDocument: async () => ({
          total: 5,
          pages: [1, 2],
          dataUrls: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']
        }),
        emitToolImages: (images, caption) => emitted.push({ images, caption })
      })
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0].images).toEqual([
      { mediaType: 'image/png', dataBase64: 'AAAA' },
      { mediaType: 'image/png', dataBase64: 'BBBB' }
    ])
    expect(emitted[0].caption).toBe('scan.pdf — pages 1–2')
    expect(out).toMatch(/attached them as vision input/i)
    // 5 total, rendered through page 2 → the tool nudges toward the next window.
    expect(out).toMatch(/3-…/)
  })

  it('passes the raw pages/scale fields through to the rasterizer', async () => {
    let seen: { pages: unknown; scale: unknown } | null = null
    await renderDocumentTool.run(
      { path: 'scan.pdf', pages: 4, scale: 3 },
      ctx({
        rasterizeDocument: async (_bytes, pages, scale) => {
          seen = { pages, scale }
          return { total: 4, pages: [4], dataUrls: ['data:image/png;base64,AAAA'] }
        },
        emitToolImages: () => {}
      })
    )
    expect(seen).toEqual({ pages: 4, scale: 3 })
  })

  it('reports when the rasterizer yields no images', async () => {
    const out = await renderDocumentTool.run(
      { path: 'scan.pdf' },
      ctx({
        rasterizeDocument: async () => ({ total: 1, pages: [1], dataUrls: [] }),
        emitToolImages: () => {}
      })
    )
    expect(out).toMatch(/no page images/i)
  })

  it('surfaces a rasterizer failure as a recoverable message', async () => {
    const out = await renderDocumentTool.run(
      { path: 'scan.pdf' },
      ctx({
        rasterizeDocument: async () => {
          throw new Error('canvas exploded')
        },
        emitToolImages: () => {}
      })
    )
    expect(out).toMatch(/failed to rasterize/i)
    expect(out).toMatch(/canvas exploded/)
  })

  it('shows an image file directly through the vision channel', async () => {
    const emitted: { images: ChatImage[]; caption?: string }[] = []
    const out = await renderDocumentTool.run(
      { path: 'pic.png' },
      ctx({ emitToolImages: (images, caption) => emitted.push({ images, caption }) })
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0].images[0].mediaType).toBe('image/png')
    expect(emitted[0].caption).toBe('pic.png')
    expect(out).toMatch(/attached pic\.png as an image/i)
  })

  it('is honest about an image file when no vision channel is wired', async () => {
    const out = await renderDocumentTool.run({ path: 'pic.png' }, ctx())
    expect(out).toMatch(/no vision input is wired/i)
  })
})
