import { describe, it, expect } from 'vitest'
import { buildFileTree, type FileTreeNode } from './file-tree'
import type { FileChange } from '@shared/types'

const ch = (path: string, over: Partial<FileChange> = {}): FileChange => ({
  path,
  kind: 'write',
  added: 1,
  removed: 0,
  ...over
})

/** Flatten a tree to "path:type" strings in order, for compact structural asserts. */
function flatten(nodes: FileTreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(`${n.path}:${n.type}`)
    if (n.children) flatten(n.children, out)
  }
  return out
}

describe('buildFileTree', () => {
  it('nests flat relative paths into folders with file leaves', () => {
    const tree = buildFileTree([ch('src/components/App.tsx'), ch('src/index.ts'), ch('README.md')])
    // Folders first then files, each alphabetised; README is a top-level file.
    expect(flatten(tree)).toEqual([
      'src:dir',
      'src/components:dir',
      'src/components/App.tsx:file',
      'src/index.ts:file',
      'README.md:file'
    ])
  })

  it('normalises backslash separators', () => {
    const tree = buildFileTree([ch('src\\lib\\util.ts')])
    expect(flatten(tree)).toEqual(['src:dir', 'src/lib:dir', 'src/lib/util.ts:file'])
  })

  it('upserts a file touched twice — one leaf, latest change wins', () => {
    const tree = buildFileTree([
      ch('app.ts', { kind: 'write', added: 10, removed: 0 }),
      ch('app.ts', { kind: 'edit', added: 2, removed: 1 })
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].type).toBe('file')
    expect(tree[0].change).toMatchObject({ kind: 'edit', added: 2, removed: 1 })
  })

  it('carries each file change (kind + counts) onto its leaf', () => {
    const tree = buildFileTree([ch('a/gone.ts', { kind: 'delete', added: 0, removed: 5 })])
    const leaf = tree[0].children?.[0]
    expect(leaf?.change).toMatchObject({ kind: 'delete', added: 0, removed: 5 })
  })

  it('sorts folders before files and ignores case', () => {
    const tree = buildFileTree([ch('zebra.ts'), ch('alpha/one.ts'), ch('Beta.ts')])
    expect(tree.map((n) => n.name)).toEqual(['alpha', 'Beta.ts', 'zebra.ts'])
  })

  it('returns an empty tree for no changes', () => {
    expect(buildFileTree([])).toEqual([])
  })
})
