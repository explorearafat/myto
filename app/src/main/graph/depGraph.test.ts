import { describe, expect, it } from 'vitest'
import { GRAPH_NODE_CAP, buildDepGraph, resolveSpecifier } from '@main/graph/depGraph'
import type { FileIndexEntry, ProjectIndex } from '@main/context/projectIndex'
import type { DepGraphRequest } from '@shared/types'

/**
 * The graph's whole risk is drawing an edge that isn't there. It resolves
 * *specifiers* (`'./utils'`, `'@shared/types'`, `'react'`) against the set of files
 * the index actually knows, so the assertions below are mostly about what it
 * REFUSES to draw: a package as a node, an ambiguous alias as an edge, a node
 * outside the requested scope, or an edge with one end dropped by the cap.
 *
 * `buildDepGraph` is pure, so everything here builds a literal index — no fs.
 */

/** An index entry with only the fields the graph reads. */
function entry(imports?: string[], summary = ''): FileIndexEntry {
  return { size: 1, mtime: 0, summary, indexedAt: 0, ...(imports != null ? { imports } : {}) }
}

/** An index from `path → imports`. */
function indexOf(files: Record<string, string[] | undefined>): ProjectIndex {
  const out: Record<string, FileIndexEntry> = {}
  for (const [path, imports] of Object.entries(files)) out[path] = entry(imports)
  return { version: 2, root: '/repo', files: out }
}

function req(
  scope: DepGraphRequest['scope'],
  touched: string[] = [],
  written: string[] = []
): DepGraphRequest {
  return { scope, touched, written }
}

/** `from → to` pairs, sorted, so edge order never makes a test flaky. */
function edgeList(edges: { from: string; to: string }[]): string[] {
  return edges.map((e) => `${e.from} -> ${e.to}`).sort()
}

describe('resolveSpecifier', () => {
  const keys = new Set([
    'src/main/index.ts',
    'src/main/util/fs.ts',
    'src/main/util/index.ts',
    'src/shared/types.ts',
    'data/seed.json'
  ])

  it('resolves a relative specifier, with or without its extension', () => {
    expect(resolveSpecifier('src/main/index.ts', './util/fs', keys)).toBe('src/main/util/fs.ts')
    expect(resolveSpecifier('src/main/index.ts', './util/fs.ts', keys)).toBe('src/main/util/fs.ts')
  })

  it('resolves a directory to its index file, and applies `..`', () => {
    expect(resolveSpecifier('src/main/index.ts', './util', keys)).toBe('src/main/util/index.ts')
    expect(resolveSpecifier('src/main/util/fs.ts', '../../shared/types', keys)).toBe(
      'src/shared/types.ts'
    )
  })

  it('resolves an alias by matching the tail of a real index key', () => {
    // The alias table lives in electron.vite.config.ts, which this module deliberately
    // does not read: `shared/types` is a suffix of exactly one file, so the edge is certain.
    expect(resolveSpecifier('src/main/index.ts', '@shared/types', keys)).toBe('src/shared/types.ts')
    expect(resolveSpecifier('src/main/index.ts', '@main/util/fs', keys)).toBe('src/main/util/fs.ts')
  })

  it('returns null for a package, a builtin, a data URL and a URL', () => {
    for (const spec of ['react', 'node:fs', 'data:text/js,1', 'https://esm.sh/x']) {
      expect(resolveSpecifier('src/main/index.ts', spec, keys)).toBeNull()
    }
  })

  it('returns null for a relative path that is not in the index', () => {
    expect(resolveSpecifier('src/main/index.ts', './nope', keys)).toBeNull()
  })

  it('refuses a one-segment tail, because it would match half a codebase', () => {
    // `types` alone is a suffix of src/shared/types.ts, but a wrong edge is worse
    // than a missing one, so two segments is the floor.
    expect(resolveSpecifier('src/main/index.ts', 'types', keys)).toBeNull()
  })

  it('treats an ambiguous tail as unresolved', () => {
    const ambiguous = new Set(['a/lib/util.ts', 'b/lib/util.ts', 'src/app.ts'])
    expect(resolveSpecifier('src/app.ts', '@x/lib/util', ambiguous)).toBeNull()
    // Longest-tail-first still finds the certain one when the specifier says more.
    expect(resolveSpecifier('src/app.ts', '@x/b/lib/util', ambiguous)).toBe('b/lib/util.ts')
  })
})

describe('buildDepGraph — nodes and edges', () => {
  const index = indexOf({
    'src/a.ts': ['./b', 'react'],
    'src/b.ts': ['node:fs'],
    'src/c.ts': ['./a'],
    'src/lonely.ts': undefined
  })

  it('draws the resolved imports and counts the rest as external', () => {
    const graph = buildDepGraph(index, req('project'))
    expect(edgeList(graph.edges)).toEqual(['src/a.ts -> src/b.ts', 'src/c.ts -> src/a.ts'])
    // `react` and `node:fs` are numbers on their nodes, never nodes of their own.
    expect(graph.nodes.map((n) => n.path)).not.toContain('react')
    const byPath = new Map(graph.nodes.map((n) => [n.path, n]))
    expect(byPath.get('src/a.ts')?.external).toBe(1)
    expect(byPath.get('src/b.ts')?.external).toBe(1)
    expect(byPath.get('src/c.ts')?.external).toBe(0)
    // No `imports` key at all is not the same as "imports nothing that resolved".
    expect(byPath.get('src/lonely.ts')?.external).toBe(0)
    expect(graph.indexed).toBe(4)
    expect(graph.omitted).toBe(0)
    expect(graph.scope).toBe('project')
  })

  it('marks touched and written, and ignores seeds the index has never seen', () => {
    const graph = buildDepGraph(index, req('project', ['src/a.ts', 'ghost.ts'], ['src/a.ts']))
    const a = graph.nodes.find((n) => n.path === 'src/a.ts')
    expect(a).toMatchObject({ touched: true, written: true })
    expect(graph.nodes.find((n) => n.path === 'src/b.ts')).toMatchObject({
      touched: false,
      written: false
    })
    // A path nothing indexed cannot become a node just because a run named it.
    expect(graph.nodes.map((n) => n.path)).not.toContain('ghost.ts')
  })

  it('normalises Windows separators and a leading ./ in the request', () => {
    const graph = buildDepGraph(index, req('run', ['src\\a.ts'], ['./src/a.ts']))
    expect(graph.nodes.find((n) => n.path === 'src/a.ts')).toMatchObject({
      touched: true,
      written: true
    })
  })

  it('carries the index summary through, and omits an empty one', () => {
    const described: ProjectIndex = {
      version: 2,
      root: '/repo',
      files: { 'src/a.ts': entry([], 'The entry point.'), 'src/b.ts': entry([]) }
    }
    const graph = buildDepGraph(described, req('project'))
    const byPath = new Map(graph.nodes.map((n) => [n.path, n]))
    expect(byPath.get('src/a.ts')?.summary).toBe('The entry point.')
    expect(byPath.get('src/b.ts')?.summary).toBeUndefined()
  })

  it('drops a self-import instead of drawing a loop', () => {
    const selfy = indexOf({ 'src/a.ts': ['./a', './a.ts'] })
    expect(buildDepGraph(selfy, req('project')).edges).toEqual([])
  })

  it('de-duplicates two specifiers that resolve to the same file', () => {
    const twice = indexOf({ 'src/a.ts': ['./b', './b.ts', '@x/src/b'], 'src/b.ts': [] })
    expect(edgeList(buildDepGraph(twice, req('project')).edges)).toEqual(['src/a.ts -> src/b.ts'])
  })
})

describe('buildDepGraph — scope', () => {
  // c → b → a, plus an island nothing in the chain mentions.
  const index = indexOf({
    'src/a.ts': [],
    'src/b.ts': ['./a'],
    'src/c.ts': ['./b'],
    'src/island.ts': []
  })

  it('run scope draws the seeds plus their immediate neighbours, both directions', () => {
    const graph = buildDepGraph(index, req('run', ['src/b.ts']))
    expect([...graph.nodes.map((n) => n.path)].sort()).toEqual([
      'src/a.ts', // what the seed imports
      'src/b.ts', // the seed
      'src/c.ts' // what imports the seed — an inbound edge from a file the run never opened
    ])
    // Two hops away is out of the blast radius; so is an unrelated file.
    expect(graph.nodes.map((n) => n.path)).not.toContain('src/island.ts')
    expect(graph.scope).toBe('run')
    // `indexed` is the honest ceiling, not the drawn count.
    expect(graph.indexed).toBe(4)
  })

  it('run scope with no touched files draws nothing rather than everything', () => {
    const graph = buildDepGraph(index, req('run'))
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
    expect(graph.omitted).toBe(0)
    expect(graph.indexed).toBe(4)
  })

  it('project scope draws every indexed file, touched or not', () => {
    const graph = buildDepGraph(index, req('project', ['src/b.ts']))
    expect(graph.nodes).toHaveLength(4)
    expect(graph.nodes.map((n) => n.path)).toContain('src/island.ts')
  })
})

describe('buildDepGraph — ranking and the cap', () => {
  it('ranks written above touched above well-connected, ties by path', () => {
    // `hub` has the highest degree by far, but a file this run WROTE is the one a
    // reviewer wants at the top of the list.
    const index = indexOf({
      'src/hub.ts': [],
      'src/one.ts': ['./hub'],
      'src/two.ts': ['./hub'],
      'src/three.ts': ['./hub'],
      'src/written.ts': [],
      'src/touched.ts': [],
      'src/aaa.ts': [],
      'src/bbb.ts': []
    })
    const graph = buildDepGraph(
      index,
      req('project', ['src/touched.ts', 'src/written.ts'], ['src/written.ts'])
    )
    const order = graph.nodes.map((n) => n.path)
    expect(order[0]).toBe('src/written.ts')
    expect(order[1]).toBe('src/touched.ts')
    expect(order[2]).toBe('src/hub.ts')
    // Everything left is degree 1 or 0; equal ranks fall back to the path so the
    // canvas gets a stable order across rebuilds.
    expect(order.slice(3)).toEqual([
      'src/one.ts',
      'src/three.ts',
      'src/two.ts',
      'src/aaa.ts',
      'src/bbb.ts'
    ])
  })

  it('caps the node list, reports what it left out, and keeps no dangling edge', () => {
    const files: Record<string, string[]> = { 'src/hub.ts': [] }
    for (let i = 0; i < 9; i++) files[`src/n${i}.ts`] = ['./hub']
    const graph = buildDepGraph(indexOf(files), req('project'), 3)

    expect(graph.nodes).toHaveLength(3)
    expect(graph.omitted).toBe(7)
    expect(graph.indexed).toBe(10)
    // Every edge that survived has both ends drawn.
    const kept = new Set(graph.nodes.map((n) => n.path))
    for (const edge of graph.edges) {
      expect(kept.has(edge.from)).toBe(true)
      expect(kept.has(edge.to)).toBe(true)
    }
    expect(graph.edges).toHaveLength(2)
  })

  it('defaults to the shared cap', () => {
    const files: Record<string, string[]> = {}
    for (let i = 0; i < GRAPH_NODE_CAP + 5; i++) files[`src/n${i}.ts`] = []
    const graph = buildDepGraph(indexOf(files), req('project'))
    expect(graph.nodes).toHaveLength(GRAPH_NODE_CAP)
    expect(graph.omitted).toBe(5)
  })
})
