import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillConfig } from '../../shared/types'
import { skillSlug } from './manager'

/*
 * File-based skill discovery.
 *
 * Alongside the skills a user configures in Settings, Myto can pick up skills dropped
 * on disk as a folder containing a `SKILL.md` — the same convention Claude Code uses
 * (`<skillsDir>/<name>/SKILL.md`), so an existing skill folder works unchanged. Each
 * file has optional `key: value` frontmatter (`name`, `description`) between `---`
 * fences; the body below is the instructions the model loads on demand.
 *
 * Security (per the brief — OpenClaw's CVE-2026-31990 was symlink traversal out of a
 * sandbox): discovery NEVER follows symlinks. A symlinked skill folder or a symlinked
 * `SKILL.md` is skipped, so a planted link can't make Myto read an arbitrary file
 * outside the opt-in skills directory. Scanning is one level deep only. Everything is
 * best-effort: an unreadable entry is skipped with a reason, never thrown.
 *
 * Reimplemented from the described behaviour — no OpenClaw code copied.
 */

/** One skill parsed from disk, plus the skills that were skipped and why. */
export interface DiscoveredSkills {
  skills: SkillConfig[]
  skipped: { path: string; reason: string }[]
}

/** Strip one pair of matching surrounding quotes from a frontmatter value. */
function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * Parse a SKILL.md into { name, description, instructions }, or return an error reason.
 * Frontmatter is optional simple `key: value` lines between leading `---` fences (no
 * external YAML dependency — only the keys skills use). `fallbackName` (the folder) is
 * used when no `name:` is given. A file with no instruction body is rejected.
 */
export function parseSkillMarkdown(
  raw: string,
  fallbackName: string
): { name: string; description: string; instructions: string } | { error: string } {
  let text = raw.replace(/^﻿/, '') // drop a BOM if present
  let name = ''
  let description = ''
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/
  const m = fence.exec(text)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase()
      if (key === 'name') name = unquote(kv[2])
      else if (key === 'description') description = unquote(kv[2])
    }
    text = text.slice(m[0].length)
  }
  const instructions = text.trim()
  if (!instructions) return { error: 'no instructions body' }
  return { name: name.trim() || fallbackName, description: description.trim(), instructions }
}

/** Is this path a real (non-symlink) regular file? lstat so a symlink is NOT followed. */
function isRealFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Scan `rootDir` one level deep for `SKILL.md` files and parse each into a
 * {@link SkillConfig}. Supports the folder convention (`<root>/<name>/SKILL.md`) and a
 * lone `<root>/SKILL.md`. Symlinks are never followed; malformed or unreadable files
 * are collected in `skipped` with a reason instead of throwing. Deterministic: entries
 * are processed in name order and the result is sorted by skill name.
 */
export function discoverSkills(rootDir: string): DiscoveredSkills {
  const skills: SkillConfig[] = []
  const skipped: { path: string; reason: string }[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return { skills, skipped } // no skills dir yet → nothing to discover.
  }

  const usedSlugs = new Set<string>()
  const candidates: { file: string; fallback: string }[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    // Dirent reflects the link itself, so a symlinked dir/file is neither a real
    // directory nor a real file here and is silently ignored (not followed).
    if (entry.isDirectory()) {
      candidates.push({ file: join(rootDir, entry.name, 'SKILL.md'), fallback: entry.name })
    } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      candidates.push({ file: join(rootDir, entry.name), fallback: 'skill' })
    }
  }

  for (const { file, fallback } of candidates) {
    if (!isRealFile(file)) continue // missing SKILL.md, or a symlink we won't follow.
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      skipped.push({ path: file, reason: 'unreadable' })
      continue
    }
    const parsed = parseSkillMarkdown(raw, fallback)
    if ('error' in parsed) {
      skipped.push({ path: file, reason: parsed.error })
      continue
    }
    const slug = skillSlug(parsed.name)
    if (usedSlugs.has(slug)) {
      skipped.push({ path: file, reason: `duplicate skill slug "${slug}"` })
      continue
    }
    usedSlugs.add(slug)
    skills.push({ id: `file:${slug}`, name: parsed.name, description: parsed.description, instructions: parsed.instructions, enabled: true })
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, skipped }
}
