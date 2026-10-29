import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fsAvailable } from './fs'
import type { ToolDef } from './registry'
import { writeCodebaseMap } from './myto-config'

/**
 * `map_codebase` — read the project ONCE, deeply, and remember it.
 *
 * A big task on a big repo wastes many turns on orientation: list_dir, read_file,
 * read_file… every session, from scratch. This tool walks the workspace in one pass
 * (bounded), reads the files that define the project's shape (manifests, entry
 * points, configs, top-level sources), and writes a structured map to
 * `.myto/codebase-map.md`. The map is injected into the system prompt of every
 * later turn in this folder — so the codebase is read once and remembered across
 * the whole task AND across sessions, instead of re-explored every time.
 *
 * For a much deeper read the agent can combine this with `spawn_agents` (fan out
 * readers over subfolders and merge their notes into the map with edit_file).
 */

/** Folders that never contribute to the map. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'out', 'build', '.next', '.nuxt',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'target',
  'vendor', 'release', '.myto', '.zcode', '.claude'
])

/** Manifest/config files that define a project's shape — read these fully-ish. */
const KEY_FILES = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
  'next.config.js', 'nuxt.config.ts', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'pubspec.yaml',
  'gemfile', 'makefile', 'dockerfile', 'docker-compose.yml', 'readme.md', 'readme',
  'vercel.json', 'firebase.json', 'tailwind.config.js', 'tailwind.config.ts'
])

const MAX_FILES = 400
const MAX_DEPTH = 6
const KEY_FILE_CAP = 1_800
const ENTRY_CAP = 1_200
const TREE_LINES_CAP = 220
const MAP_CAP = 40_000

interface Walked {
  path: string
  rel: string
  size: number
}

/** Bounded recursive walk collecting candidate source files. Pure fs, no follows. */
function walk(dir: string, root: string, depth: number, out: Walked[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return
    if (SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full, root, depth + 1, out)
      continue
    }
    if (st.size > 120_000) continue // skip huge generated/binary-ish files
    const lower = name.toLowerCase()
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|h|json|toml|yaml|yml|md|html|css|scss|sql|sh)$/.test(lower)) continue
    out.push({ path: full, rel: relative(root, full).replace(/\\/g, '/'), size: st.size })
  }
}

/** Priority score for which files get their content sampled into the map. */
function score(rel: string): number {
  const lower = rel.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  if (KEY_FILES.has(base)) return 0
  if (/^src\/(index|main|app|server)\.[a-z]+$/.test(lower)) return 1
  if ((lower.match(/\//g) ?? []).length <= 1) return 2 // near the root
  return 3
}

export const mapCodebaseTool: ToolDef = {
  name: 'map_codebase',
  description:
    'Read the project once, deeply, and remember it: walks the working folder, reads the files ' +
    'that define the project (manifests, entry points, configs, top-level sources) and writes a ' +
    'structured map to .myto/codebase-map.md. That map is then injected into your context on ' +
    'every later turn in this folder — so for follow-up work do NOT re-explore from scratch; ' +
    'trust the map and read only the specific files you are changing. Run this at the start of ' +
    'any substantial task on an unfamiliar codebase.',
  usage: '{}',
  sideEffect: 'write',
  available: fsAvailable,
  async run(_input, ctx) {
    const root = ctx.workspaceDir ? resolve(ctx.workspaceDir) : undefined
    if (!root) return 'map_codebase: no working folder is set.'

    const files: Walked[] = []
    walk(root, root, 0, files)
    if (files.length === 0) {
      return 'map_codebase: the working folder has no readable source files.'
    }

    // The tree (bounded) — structure is the most durable fact about a repo.
    const treeLines = files
      .map((f) => f.rel)
      .sort()
      .slice(0, TREE_LINES_CAP)
    const tree = treeLines.join('\n')

    // Sampled content of the highest-priority files.
    const sampled = [...files].sort((a, b) => score(a.rel) - score(b.rel) || a.rel.localeCompare(b.rel))
    const parts: string[] = []
    let budget = MAP_CAP - 2_000
    for (const f of sampled) {
      if (budget <= 400) break
      const isKey = score(f.rel) === 0
      const cap = isKey ? KEY_FILE_CAP : ENTRY_CAP
      try {
        const text = readFileSync(f.path, 'utf8')
        const clipped = text.length > cap ? text.slice(0, cap) + '\n…[truncated]' : text
        const block = `### ${f.rel}\n\`\`\`\n${clipped}\n\`\`\``
        if (block.length > budget) break
        parts.push(block)
        budget -= block.length + 1
      } catch {
        continue
      }
      if (parts.length >= 40) break
    }

    const map = [
      `# Codebase map — ${root}`,
      `Generated ${new Date().toISOString()} by map_codebase. ${files.length} source files indexed.`,
      '',
      '## Files',
      '```',
      tree,
      '```',
      '',
      '## Key files (sampled)',
      ...parts
    ].join('\n')
    const finalMap = map.length > MAP_CAP ? map.slice(0, MAP_CAP) + '\n…[truncated]' : map
    const wrote = writeCodebaseMap(root, finalMap)

    const topDirs = new Map<string, number>()
    for (const f of files) {
      const top = f.rel.includes('/') ? f.rel.split('/')[0] : '.'
      topDirs.set(top, (topDirs.get(top) ?? 0) + 1)
    }
    const shape = [...topDirs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([d, n]) => `${d}/ (${n} files)`)
      .join(', ')

    return (
      `Mapped ${files.length} source files → .myto/codebase-map.md${wrote ? ' (saved)' : ' (save FAILED — check permissions)'}.\n` +
      `Project shape: ${shape}\n` +
      'The map is now injected into your context every turn in this folder. From here on, read ' +
      'only the specific files you are changing — do not re-explore the project.'
    )
  }
}
