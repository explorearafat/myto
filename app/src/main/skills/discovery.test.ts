import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillMarkdown, discoverSkills } from './discovery'

// Step 5 (Gap A4): pick up skills dropped on disk as <dir>/<name>/SKILL.md, alongside
// the settings skills. Parsing is dependency-free; discovery never follows symlinks
// (the OpenClaw CVE-2026-31990 lesson) and skips malformed files with a reason.

describe('parseSkillMarkdown', () => {
  it('reads name/description from frontmatter and keeps the body as instructions', () => {
    const r = parseSkillMarkdown('---\nname: PDF Forms\ndescription: Fill PDFs\n---\nStep one.\nStep two.', 'folder')
    expect(r).toEqual({ name: 'PDF Forms', description: 'Fill PDFs', instructions: 'Step one.\nStep two.' })
  })
  it('falls back to the folder name and empty description when there is no frontmatter', () => {
    expect(parseSkillMarkdown('just do it', 'my-skill')).toEqual({
      name: 'my-skill', description: '', instructions: 'just do it'
    })
  })
  it('strips surrounding quotes from frontmatter values', () => {
    const r = parseSkillMarkdown('---\nname: "Quoted Name"\n---\nbody', 'f')
    expect('error' in r ? r : r.name).toBe('Quoted Name')
  })
  it('rejects a file with no instruction body', () => {
    expect(parseSkillMarkdown('---\nname: Empty\n---\n   ', 'f')).toEqual({ error: 'no instructions body' })
  })
})

describe('discoverSkills', () => {
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })
  const mkRoot = (): string => (root = mkdtempSync(join(tmpdir(), 'myto-skills-')))
  const writeSkill = (r: string, folder: string, body: string): void => {
    mkdirSync(join(r, folder), { recursive: true })
    writeFileSync(join(r, folder, 'SKILL.md'), body)
  }

  it('returns nothing when the skills dir does not exist', () => {
    expect(discoverSkills(join(tmpdir(), 'myto-nope-does-not-exist-xyz'))).toEqual({ skills: [], skipped: [] })
  })

  it('discovers a folder skill and marks it enabled with a file: id', () => {
    const r = mkRoot()
    writeSkill(r, 'pdf', '---\nname: PDF Forms\ndescription: Fill PDFs\n---\ndo it')
    const { skills, skipped } = discoverSkills(r)
    expect(skipped).toEqual([])
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ id: 'file:pdf_forms', name: 'PDF Forms', description: 'Fill PDFs', enabled: true })
  })

  it('skips a malformed (empty-body) SKILL.md with a reason', () => {
    const r = mkRoot()
    writeSkill(r, 'broken', '---\nname: Broken\n---\n')
    const { skills, skipped } = discoverSkills(r)
    expect(skills).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toMatch(/no instructions body/)
  })

  it('keeps the first of two skills that slugify to the same name, skipping the rest', () => {
    const r = mkRoot()
    writeSkill(r, 'a-alpha', '---\nname: Alpha\n---\nfirst')
    writeSkill(r, 'b-alpha', '---\nname: alpha!\n---\nsecond') // same slug "alpha"
    const { skills, skipped } = discoverSkills(r)
    expect(skills).toHaveLength(1)
    expect(skills[0].instructions).toBe('first') // a-alpha sorts first
    expect(skipped[0].reason).toMatch(/duplicate skill slug "alpha"/)
  })

  it('does NOT follow a symlinked SKILL.md (traversal guard)', () => {
    const r = mkRoot()
    const secret = join(r, 'secret.md')
    writeFileSync(secret, '---\nname: Leaked\n---\nsecret contents')
    mkdirSync(join(r, 'evil'))
    try {
      symlinkSync(secret, join(r, 'evil', 'SKILL.md'))
    } catch {
      return // symlinks unsupported here (e.g. unprivileged Windows) — guard is moot.
    }
    const { skills } = discoverSkills(r)
    expect(skills.find((s) => s.name === 'Leaked')).toBeUndefined()
  })
})
