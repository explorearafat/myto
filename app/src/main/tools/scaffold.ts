/**
 * scaffold_deploy — write deploy/platform config into the Cowork working folder so whatever
 * Myto builds is immediately pushable to GitHub and hostable on Vercel / Netlify / Docker.
 * All generation is the pure cowork-scaffold module; this file only reads package.json,
 * detects the project shape, and writes the returned files inside the workspace sandbox.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import type { ToolContext, ToolDef } from './registry'
import { fsAvailable, resolveInWorkspace } from './fs'
import {
  detectProjectProfile,
  buildScaffold,
  ALL_SCAFFOLD_TARGETS,
  type PackageJsonLike,
  type ScaffoldTarget
} from '../cowork-scaffold'

/** Keep only recognized, de-duplicated targets; accepts an array or a comma string. */
function normalizeTargets(raw: unknown): ScaffoldTarget[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const out: ScaffoldTarget[] = []
  for (const item of arr) {
    const t = String(item).trim() as ScaffoldTarget
    if (ALL_SCAFFOLD_TARGETS.includes(t) && !out.includes(t)) out.push(t)
  }
  return out
}

/** Read a trimmed non-empty string field from a tool input, or null. */
function readOptString(input: unknown, key: string): string | null {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Read a strict-true boolean field from a tool input. */
function readBool(input: unknown, key: string): boolean {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return v === true
}

async function runScaffold(input: unknown, ctx: ToolContext): Promise<string> {
  if (!ctx.workspaceDir) return 'scaffold_deploy needs an open working folder (Cowork mode).'
  const root = ctx.workspaceDir
  const targets = normalizeTargets(
    input && typeof input === 'object' ? (input as Record<string, unknown>).targets : undefined
  )
  const overwrite = readBool(input, 'overwrite')
  let pkg: PackageJsonLike | null = null
  const pkgAbs = resolveInWorkspace(root, 'package.json')
  if (pkgAbs) {
    try {
      pkg = JSON.parse(await readFile(pkgAbs, 'utf8')) as PackageJsonLike
    } catch {
      pkg = null
    }
  }
  let rootFiles: string[] = []
  try {
    rootFiles = await readdir(root)
  } catch {
    rootFiles = []
  }
  const profile = detectProjectProfile(pkg, rootFiles)
  const projectName = readOptString(input, 'projectName') ?? pkg?.name ?? basename(root) ?? 'app'
  const files = buildScaffold(profile, { targets, projectName, now: new Date().toISOString() })
  const written: string[] = []
  const skipped: string[] = []
  for (const f of files) {
    const abs = resolveInWorkspace(root, f.path)
    if (!abs) {
      skipped.push(`${f.path} (outside the working folder)`)
      continue
    }
    let before: string | null = null
    try {
      before = await readFile(abs, 'utf8')
    } catch {
      before = null
    }
    if (before !== null && !overwrite) {
      skipped.push(`${f.path} (exists — pass overwrite:true to replace)`)
      continue
    }
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, f.contents, 'utf8')
    ctx.onFileSnapshot?.({
      path: abs,
      before,
      after: f.contents,
      kind: before === null ? 'write' : 'edit',
      existed: before !== null
    })
    written.push(f.path)
  }
  const parts = [`Scaffolded ${written.length} deploy file${written.length === 1 ? '' : 's'} for a ${profile.kind} project (${projectName}).`]
  if (written.length) parts.push(`Wrote: ${written.join(', ')}.`)
  if (skipped.length) parts.push(`Skipped: ${skipped.join('; ')}.`)
  parts.push(
    'Next: commit and push to GitHub, then import the repo on Vercel — or add the VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID repo secrets so .github/workflows/deploy.yml auto-deploys.'
  )
  return parts.join(' ')
}

export const scaffoldDeployTool: ToolDef = {
  name: 'scaffold_deploy',
  description:
    'Generate deploy/platform config for the working folder (GitHub Actions CI + deploy, vercel.json, netlify.toml, Dockerfile, .gitignore, README, .env.example, .myto/project.json) tuned to the detected framework. Existing files are kept unless overwrite:true.',
  usage: '{"targets": ["github", "vercel", "docker"], "projectName": "my-app", "overwrite": false}',
  sideEffect: 'write',
  schema: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        items: { type: 'string', enum: [...ALL_SCAFFOLD_TARGETS] },
        description: 'Which config to emit. Omit or leave empty for all of them.'
      },
      projectName: { type: 'string', description: 'Project name for README / package tag. Defaults to package.json name or the folder name.' },
      overwrite: { type: 'boolean', description: 'Replace files that already exist. Default false.' }
    },
    additionalProperties: false
  },
  available: fsAvailable,
  run: runScaffold
}
