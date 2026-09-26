import { readFile } from 'node:fs/promises'
import { toErrorMessage } from '../providers/http'
import type { ToolContext, ToolDef } from './registry'
import { fsAvailable, resolveInWorkspace } from './fs'
import { checkArtifact } from '../cowork-artifacts'

/** Read a non-empty `path` string out of a tool input, or null. */
function readPath(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).path : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/**
 * verify_file (Cowork, Track-1 #4): confirm a deliverable is a REAL, valid file of
 * its type — a genuine OOXML package (xlsx/pptx/docx), PDF, or zip — not an empty
 * stub or a saved error message. Read-only (no sideEffect → no permission prompt),
 * gated exactly like the fs read tools (Cowork + a working folder). The heavy lifting
 * is the pure {@link checkArtifact}; this only resolves the path inside the sandbox,
 * reads the bytes, and phrases the verdict for the model.
 */
export const verifyFileTool: ToolDef = {
  name: 'verify_file',
  description:
    'Check that a deliverable you generated is a REAL, valid file of its type — a genuine xlsx/pptx/docx (OOXML) package, PDF, or zip — not an empty stub or a saved error message. Call it after producing a document/spreadsheet/presentation/PDF, before you report it done.',
  usage: '{"path": "report.xlsx"}',
  schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File to verify, relative to the working folder.' } },
    required: ['path'],
    additionalProperties: false
  },
  available: fsAvailable,
  async run(input: unknown, ctx: ToolContext): Promise<string> {
    const rel = readPath(input)
    if (!rel) return 'verify_file needs a JSON input like {"path": "report.xlsx"} (relative to the working folder).'
    const abs = ctx.workspaceDir ? resolveInWorkspace(ctx.workspaceDir, rel) : null
    if (!abs) return `verify_file: "${rel}" is outside the working folder and was refused.`
    let bytes: Buffer
    try {
      bytes = await readFile(abs)
    } catch (err) {
      return `verify_file: could not read "${rel}" — ${toErrorMessage(err)}. Did the generating step actually write it?`
    }
    const result = checkArtifact(rel, bytes)
    return result.ok
      ? `verify_file: OK — ${result.detail}`
      : `verify_file: INVALID — ${result.detail} Fix the generating step and re-run before reporting this deliverable as done.`
  }
}
