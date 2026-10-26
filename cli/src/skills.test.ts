import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, parseSkill, saveSkill, skillTemplate, skillsDirs } from './skills'

const makeTemp = (): string => mkdtempSync(join(tmpdir(), 'myto-skills-'))
const cleanup = (dirs: string[]): void => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))

describe('parseSkill', () => {
  it('takes the first # heading as the name and the rest as instructions', () => {
    const parsed = parseSkill('# Code review\n\nBe thorough.\n- check diffs')
    expect(parsed?.name).toBe('Code review')
    expect(parsed?.instructions).toBe('Be thorough.\n- check diffs')
  })
  it('is null without a heading, and survives an empty body', () => {
    expect(parseSkill('just prose, no heading')).toBeNull()
    expect(parseSkill('')).toBeNull()
    const headOnly = parseSkill('# Solo')
    expect(headOnly?.name).toBe('Solo')
    expect(headOnly?.instructions).toBe('Solo')
  })
})

describe('listSkills', () => {
  it('discovers workspace skills first and user skills second, no shadowing', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const wsDir = skillsDirs(ws, home)[0].dir
      const userDir = skillsDirs(ws, home)[1].dir
      mkdirSync(wsDir, { recursive: true })
      mkdirSync(userDir, { recursive: true })
      writeFileSync(join(wsDir, 'review.md'), '# Review\nworkspace version')
      writeFileSync(join(userDir, 'review.md'), '# Review\nuser version')
      writeFileSync(join(userDir, 'deploy.md'), '# Deploy\nship it')
      const scan = listSkills(ws, home)
      expect(scan.errors).toEqual([])
      const names = scan.skills.map((s) => s.name)
      expect(names).toEqual(['Review', 'Deploy'])
      expect(scan.skills[0].source).toBe('workspace')
      expect(scan.skills[0].instructions).toBe('workspace version')
      expect(scan.skills[1].source).toBe('user')
    } finally {
      cleanup([ws, home])
    }
  })
  it('reports malformed files instead of throwing', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const dir = skillsDirs(ws, home)[0].dir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'bad.md'), 'no heading here')
      const scan = listSkills(ws, home)
      expect(scan.skills).toEqual([])
      expect(scan.errors).toHaveLength(1)
      expect(scan.errors[0].error).toContain('heading')
    } finally {
      cleanup([ws, home])
    }
  })
  it('returns empty (not an error) when no directories exist', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const scan = listSkills(ws, home)
      expect(scan.skills).toEqual([])
      expect(scan.errors).toEqual([])
    } finally {
      cleanup([ws, home])
    }
  })
})

describe('saveSkill + template', () => {
  it('writes a parseable file into the chosen directory with a slug name', () => {
    const ws = makeTemp()
    const home = makeTemp()
    try {
      const path = saveSkill(ws, 'My Cool Skill!', skillTemplate('My Cool Skill!', 'reviews code'), 'user', home)
      expect(path.startsWith(home)).toBe(true)
      expect(path).toContain('my-cool-skill.md')
      const parsed = parseSkill(readFileSync(path, 'utf8'))
      expect(parsed?.name).toBe('My Cool Skill!')
      expect(parsed?.instructions).toContain('reviews code')
    } finally {
      cleanup([ws, home])
    }
  })
})
