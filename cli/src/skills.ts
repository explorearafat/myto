/*
 * Skills — reusable instruction packs that shape how the agent works. A skill
 * is a markdown file: its first `# heading` is the display name, everything
 * after is the instruction body that rides the system prompt. Skills live in
 * `~/.myto/skills/` (global) and `<workspace>/.myto/skills/` (project-local);
 * the workspace copy wins on a name clash.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Skill {
  name: string
  path: string
  /** 'user' = ~/.myto/skills, 'workspace' = <workspace>/.myto/skills */
  source: 'user' | 'workspace'
  instructions: string
}

export interface SkillScan {
  skills: Skill[]
  /** Files that exist but couldn't be read/parsed, reported honestly. */
  errors: { path: string; error: string }[]
}

/** The two directories skills are discovered in, in priority order. */
export function skillsDirs(workspace: string, homeDir: string = homedir()): { dir: string; source: 'user' | 'workspace' }[] {
  return [
    { dir: join(workspace, '.myto', 'skills'), source: 'workspace' },
    { dir: join(homeDir, '.myto', 'skills'), source: 'user' }
  ]
}

/** Parse one skill file's text: `# Name` heading + instruction body. */
export function parseSkill(raw: string): { name: string; instructions: string } | null {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return null
  const m = /^#\s+(.+)$/.exec(text.split('\n', 1)[0] ?? '')
  const name = (m?.[1] ?? '').trim()
  if (!name) return null
  const instructions = text.split('\n').slice(1).join('\n').trim()
  return { name, instructions: instructions || name }
}

/** Scan both skill directories. Later sources never shadow earlier ones. */
export function listSkills(workspace: string, homeDir?: string): SkillScan {
  const skills: Skill[] = []
  const errors: { path: string; error: string }[] = []
  const seen = new Set<string>()
  for (const { dir, source } of skillsDirs(workspace, homeDir)) {
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
    } catch (err) {
      errors.push({ path: dir, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    for (const file of entries) {
      const path = join(dir, file)
      try {
        const parsed = parseSkill(readFileSync(path, 'utf8'))
        if (!parsed) {
          errors.push({ path, error: 'no "# Name" heading on the first line' })
          continue
        }
        const key = parsed.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        skills.push({ name: parsed.name, path, source, instructions: parsed.instructions })
      } catch (err) {
        errors.push({ path, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { skills, errors }
}

/** A starter skill file body — pure so tests can assert it. */
export function skillTemplate(name: string, description = ''): string {
  return [
    `# ${name}`,
    description || `What this skill does and when the agent should use it.`,
    '',
    '## Instructions',
    '',
    '- Explain the approach before touching files.',
    '- Keep edits minimal and focused.',
    '- Run the tests when you are done and report honestly.',
    ''
  ].join('\n')
}

/** Write a new skill file; returns the path. Throws on IO errors (caller reports). */
export function saveSkill(workspace: string, name: string, body: string, source: 'user' | 'workspace' = 'user', homeDir?: string): string {
  const dir = skillsDirs(workspace, homeDir).find((d) => d.source === source)!.dir
  mkdirSync(dir, { recursive: true })
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
  const path = join(dir, slug + '.md')
  writeFileSync(path, body, 'utf8')
  return path
}
