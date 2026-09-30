import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTool } from './create-file'
import type { ToolContext } from './registry'
import { checkArtifact } from '../cowork-artifacts'

/**
 * End-to-end test of the create_file TOOL (not just the builders): a real temp workspace,
 * the real sandbox path resolution, real bytes on disk, byte-validated. Proves the glue
 * — format routing, resolveInWorkspaceReal, checkArtifact, and the file write — all connect.
 */
describe('create_file tool', () => {
  let dir: string
  const ctx = (): ToolContext => ({ mode: 'cowork', workspaceDir: dir }) as unknown as ToolContext

  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'myto-createfile-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('writes a valid .docx from Markdown', async () => {
    const msg = await createFileTool.run({ path: 'report.docx', content: '# Title\n\nHello **world**.' }, ctx())
    expect(msg).toContain('Created report.docx')
    expect(checkArtifact('report.docx', await readFile(join(dir, 'report.docx'))).ok).toBe(true)
  })

  it('writes a valid .xlsx from CSV', async () => {
    await createFileTool.run({ path: 'data.xlsx', content: 'Name,Score\nAda,99' }, ctx())
    expect(checkArtifact('data.xlsx', await readFile(join(dir, 'data.xlsx'))).ok).toBe(true)
  })

  it('writes a valid .pptx from slide Markdown', async () => {
    await createFileTool.run({ path: 'deck.pptx', content: '# One\n\n- a\n\n---\n\n# Two' }, ctx())
    expect(checkArtifact('deck.pptx', await readFile(join(dir, 'deck.pptx'))).ok).toBe(true)
  })

  it('pretty-prints valid JSON text output', async () => {
    await createFileTool.run({ path: 'cfg.json', content: '{"b":2,"a":1}' }, ctx())
    expect(await readFile(join(dir, 'cfg.json'), 'utf8')).toBe('{\n  "b": 2,\n  "a": 1\n}')
  })

  it('refuses PDF (points at create_document)', async () => {
    expect(await createFileTool.run({ path: 'x.pdf', content: '# hi' }, ctx())).toContain('create_document')
  })

  it('refuses a path that escapes the workspace', async () => {
    const msg = await createFileTool.run({ path: '../escape.docx', content: '# hi' }, ctx())
    expect(msg).toContain('outside the working folder')
  })
})
