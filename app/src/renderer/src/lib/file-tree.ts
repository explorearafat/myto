import type { FileChange } from '@shared/types'

/**
 * Pure helper for the live Working-tree pane (Build mode): fold a flat list of
 * {@link FileChange} rows (each a workspace-relative path plus its latest kind and
 * line counts) into a nested directory tree the pane can render as collapsible
 * folders with file leaves.
 *
 * Renderer-side on purpose: the renderer imports nothing from `main/`, and the pane
 * is the only consumer, so this lives beside it rather than in a shared module.
 * Kept pure (no React, no DOM) so it unit-tests in isolation.
 */

export interface FileTreeNode {
  /** The segment name shown in the row (e.g. `app.ts`, or `src` for a folder). */
  name: string
  /** Full workspace-relative path: the file's path, or the folder's path prefix. */
  path: string
  /** A folder (has children) or a file leaf (carries its change). */
  type: 'file' | 'dir'
  /** Child nodes — folders only; sorted dirs-first then alphabetically. */
  children?: FileTreeNode[]
  /** The latest change for this file — files only. */
  change?: FileChange
}

/** Split a path on either separator and drop empty segments (leading `/`, `//`). */
function segments(path: string): string[] {
  return path.split(/[/\\]+/).filter(Boolean)
}

/** Sort a node's children: folders before files, then case-insensitive by name. */
function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const n of nodes) if (n.children) sortNodes(n.children)
}

/**
 * Build the directory tree for the Working-tree pane. Later entries for the same
 * path WIN (the list is append-order, so the newest change for a file replaces an
 * earlier one), matching how the store upserts changes. Returns the top-level nodes.
 */
export function buildFileTree(changes: readonly FileChange[]): FileTreeNode[] {
  const roots: FileTreeNode[] = []
  // Index of folder nodes by their path prefix, so repeated paths reuse the same dirs.
  const dirIndex = new Map<string, FileTreeNode>()

  for (const change of changes) {
    const parts = segments(change.path)
    if (parts.length === 0) continue

    let siblings = roots
    let prefix = ''
    // Walk (creating as needed) the folder chain for all but the final segment.
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      let dir = dirIndex.get(prefix)
      if (!dir) {
        dir = { name: parts[i], path: prefix, type: 'dir', children: [] }
        dirIndex.set(prefix, dir)
        siblings.push(dir)
      }
      siblings = dir.children as FileTreeNode[]
    }

    // The leaf file node. Upsert by path so the newest change for a file wins and
    // a file touched twice shows once.
    const leafName = parts[parts.length - 1]
    const leafPath = parts.join('/')
    const existing = siblings.find((n) => n.type === 'file' && n.path === leafPath)
    if (existing) {
      existing.change = change
    } else {
      siblings.push({ name: leafName, path: leafPath, type: 'file', change })
    }
  }

  sortNodes(roots)
  return roots
}
