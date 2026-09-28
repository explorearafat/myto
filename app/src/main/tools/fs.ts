import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path'
import { toErrorMessage } from '../providers/http'
import type { ToolDef, ToolGate } from './registry'

/**
 * The Cowork filesystem tools: {@link listDirTool}, {@link readFileTool},
 * {@link writeFileTool}, and {@link editFileTool}. Together they are what turns
 * Cowork from "a chat that can browse" into an agent that works across a folder —
 * it can explore, read, create, and edit files toward the goal the user gave it.
 *
 * Every one of them is sandboxed to the user's chosen working folder
 * ({@link CoworkSettings.workspaceDir}) via {@link resolveInWorkspace}, and every
 * one is gated by {@link fsAvailable} so it is neither advertised nor runnable
 * outside Cowork mode or before a folder is picked. That gate is the trust
 * boundary: switching to Cowork and choosing a folder is the user's explicit
 * opt-in to Myto reading and writing inside it.
 */

/** Largest file body handed back to the model on a read, in characters. */
const READ_CAP = 60_000
/** Largest number of directory entries listed in one `list_dir`. */
const LIST_CAP = 400

/**
 * Resolve a model-supplied relative path against the working folder, returning the
 * absolute path only when it stays inside. Returns null for anything that escapes
 * — a `..` traversal, an absolute path, or (on Windows) a different drive — which
 * the caller turns into a refusal. This is the single chokepoint every fs tool
 * goes through, so the sandbox can't be bypassed by one tool forgetting to check.
 */
export function resolveInWorkspace(workspaceDir: string, rel: string): string | null {
  if (typeof rel !== 'string' || !workspaceDir) return null
  const root = resolve(workspaceDir)
  const target = resolve(root, rel)
  if (target === root) return root
  const relPath = relative(root, target)
  // A child path never starts with '..' and is never absolute; anything that does
  // has climbed out of (or off) the root.
  if (relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) return null
  return target
}

/**
 * The filesystem tools' precondition: an agentic mode (Cowork or Research) plus a
 * root to work in. Cowork's root is the user's chosen folder; Research's is set by
 * the loop to the user's home directory (broad, permission-gated access — the mandate's
 * "reach any folder"). `resolveInWorkspace` still confines every path under that root.
 */
export function fsAvailable(gate: ToolGate): boolean {
  return (
    (gate.mode === 'cowork' || gate.mode === 'research') &&
    typeof gate.workspaceDir === 'string' &&
    gate.workspaceDir.trim().length > 0
  )
}

/** Read a non-empty `path` string out of a tool input, or null. */
function readPath(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).path : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/** Read a `content` string (empty string is valid — an empty file), or null. */
function readContent(input: unknown): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).content : undefined
  return typeof raw === 'string' ? raw : null
}

/** Resolve `input.path` against the context's workspace, or return a refusal string. */
function pathInWorkspace(
  input: unknown,
  workspaceDir: string | null,
  toolName: string
): { abs: string; rel: string } | string {
  const rel = readPath(input)
  if (!rel) return `${toolName} needs a JSON input like {"path": "src/app.ts"} (relative to the working folder).`
  const abs = workspaceDir ? resolveInWorkspace(workspaceDir, rel) : null
  if (!abs) return `${toolName}: "${rel}" is outside the working folder and was refused.`
  return { abs, rel }
}

export const listDirTool: ToolDef = {
  name: 'list_dir',
  description: 'List the files and folders inside a directory of the working folder (folders marked [dir]).',
  usage: '{"path": "src"}',
  available: fsAvailable,
  async run(input, ctx) {
    // `path` is optional for list_dir; default to the folder root.
    const rel = readPath(input) ?? '.'
    const abs = ctx.workspaceDir ? resolveInWorkspace(ctx.workspaceDir, rel) : null
    if (!abs) return `list_dir: "${rel}" is outside the working folder and was refused.`
    try {
      const entries = await readdir(abs, { withFileTypes: true })
      if (entries.length === 0) return `(${rel} is empty)`
      entries.sort((a, b) => a.name.localeCompare(b.name))
      const shown = entries.slice(0, LIST_CAP)
      const lines = shown.map((e) => `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`)
      const more = entries.length > LIST_CAP ? `\n…and ${entries.length - LIST_CAP} more` : ''
      return `${rel}:\n${lines.join('\n')}${more}`
    } catch (err) {
      return `list_dir failed for "${rel}": ${toErrorMessage(err)}`
    }
  }
}

export const readFileTool: ToolDef = {
  name: 'read_file',
  description: 'Read a text file from the working folder and return its contents.',
  usage: '{"path": "src/app.ts"}',
  available: fsAvailable,
  async run(input, ctx) {
    const r = pathInWorkspace(input, ctx.workspaceDir, 'read_file')
    if (typeof r === 'string') return r
    try {
      const text = await readFile(r.abs, 'utf8')
      if (text.length > READ_CAP) return `${text.slice(0, READ_CAP)}\n…[truncated at ${READ_CAP} chars]`
      return text || '(the file is empty)'
    } catch (err) {
      return `read_file failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

export const writeFileTool: ToolDef = {
  name: 'write_file',
  description: 'Create or overwrite a text file in the working folder (parent folders are created as needed).',
  usage: '{"path": "src/app.ts", "content": "…"}',
  sideEffect: 'write',
  available: fsAvailable,
  async run(input, ctx) {
    const r = pathInWorkspace(input, ctx.workspaceDir, 'write_file')
    if (typeof r === 'string') return r
    const content = readContent(input)
    if (content == null) return 'write_file needs a "content" string, e.g. {"path": "notes.md", "content": "…"}.'
    try {
      await mkdir(dirname(r.abs), { recursive: true })
      // Capture the prior bytes (if any) BEFORE overwriting, so the write is rewindable.
      let before: string | null = null
      try {
        before = await readFile(r.abs, 'utf8')
      } catch {
        before = null // new file — nothing to restore to on rewind (delete instead)
      }
      await writeFile(r.abs, content, 'utf8')
      ctx.onFileSnapshot?.({ path: r.abs, before, after: content, kind: 'write', existed: before !== null })
      return `Wrote ${content.length} character${content.length === 1 ? '' : 's'} to ${r.rel}.`
    } catch (err) {
      return `write_file failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

export const editFileTool: ToolDef = {
  name: 'edit_file',
  description:
    'Replace an exact snippet of text in a working-folder file. "old" must be unique unless "all" is true.',
  usage: '{"path": "src/app.ts", "old": "foo", "new": "bar"}',
  sideEffect: 'write',
  available: fsAvailable,
  async run(input, ctx) {
    const r = pathInWorkspace(input, ctx.workspaceDir, 'edit_file')
    if (typeof r === 'string') return r
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const oldText = typeof o.old === 'string' ? o.old : null
    const newText = typeof o.new === 'string' ? o.new : null
    const all = o.all === true
    if (oldText == null || newText == null) {
      return 'edit_file needs {"path": "…", "old": "…", "new": "…"} (both old and new are strings).'
    }
    if (oldText === '') return 'edit_file: "old" cannot be empty — give the exact text to replace.'
    try {
      let before: string
      try {
        before = await readFile(r.abs, 'utf8')
      } catch (readErr) {
        // The single most common misfire: the model tries to edit a file it hasn't
        // created yet. A raw "ENOENT" sends it in circles; point it straight at the
        // tool that CAN create the file instead of failing opaquely.
        if ((readErr as { code?: string })?.code === 'ENOENT') {
          return `edit_file: ${r.rel} does not exist yet — use write_file to create it (edit_file only replaces text already in a file).`
        }
        throw readErr
      }
      const count = before.split(oldText).length - 1
      if (count === 0) return `edit_file: the "old" text was not found in ${r.rel}. Read the file first to copy it exactly.`
      if (count > 1 && !all) {
        return `edit_file: "old" appears ${count} times in ${r.rel}. Make it unique (add surrounding context) or pass "all": true.`
      }
      const after = all ? before.split(oldText).join(newText) : before.replace(oldText, newText)
      await writeFile(r.abs, after, 'utf8')
      ctx.onFileSnapshot?.({ path: r.abs, before, after, kind: 'edit', existed: true })
      const n = all ? count : 1
      return `Edited ${r.rel} (${n} replacement${n === 1 ? '' : 's'}).`
    } catch (err) {
      return `edit_file failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

export const deleteFileTool: ToolDef = {
  name: 'delete_file',
  description:
    'Delete a file from the working folder — e.g. remove a throwaway helper script once the real deliverable exists.',
  usage: '{"path": "scratch/build.py"}',
  sideEffect: 'write',
  available: fsAvailable,
  async run(input, ctx) {
    const r = pathInWorkspace(input, ctx.workspaceDir, 'delete_file')
    if (typeof r === 'string') return r
    // Refuse to delete the workspace root itself.
    if (r.abs === (ctx.workspaceDir ? resolve(ctx.workspaceDir) : '')) {
      return 'delete_file: refusing to delete the working folder itself.'
    }
    try {
      // Capture the prior bytes before removal so a delete is rewindable (best-effort:
      // a directory or non-text/unreadable target snapshots without a body).
      let before: string | null = null
      try {
        before = await readFile(r.abs, 'utf8')
      } catch {
        before = null
      }
      await rm(r.abs, { recursive: true, force: false })
      ctx.onFileSnapshot?.({ path: r.abs, before, after: null, kind: 'delete', existed: true })
      return `Deleted ${r.rel}.`
    } catch (err) {
      return `delete_file failed for "${r.rel}": ${toErrorMessage(err)}`
    }
  }
}

/** All Cowork filesystem tools, in the order they're advertised to the model. */
export const fsTools: readonly ToolDef[] = [
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool
]
