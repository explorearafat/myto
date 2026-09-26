import { describe, it, expect } from 'vitest'
import {
  sanitizeRepoName,
  deriveRepoName,
  isGhAuthenticated,
  parseRepoUrl,
  buildRepoCreateArgs,
  vercelNextSteps
} from './cowork-publish'

describe('sanitizeRepoName', () => {
  it('keeps a name that is already legal', () => {
    expect(sanitizeRepoName('my-app_2.0')).toBe('my-app_2.0')
  })
  it('replaces spaces and illegal characters with a single hyphen', () => {
    expect(sanitizeRepoName('My Cool App!!')).toBe('My-Cool-App')
  })
  it('collapses repeated hyphens and trims leading/trailing dots and hyphens', () => {
    expect(sanitizeRepoName('  --Hello..World--  ')).toBe('Hello..World')
    expect(sanitizeRepoName('...weird...')).toBe('weird')
  })
  it('falls back to "project" when nothing usable survives', () => {
    expect(sanitizeRepoName('   ')).toBe('project')
    expect(sanitizeRepoName('***')).toBe('project')
  })
  it('caps the name at 100 characters', () => {
    expect(sanitizeRepoName('a'.repeat(150)).length).toBe(100)
  })
})

describe('deriveRepoName', () => {
  it('prefers an explicit name (sanitized)', () => {
    expect(deriveRepoName('/home/me/whatever', 'Chosen Name')).toBe('Chosen-Name')
  })
  it('derives from a POSIX folder basename', () => {
    expect(deriveRepoName('/home/me/my project')).toBe('my-project')
  })
  it('derives from a Windows folder basename', () => {
    expect(deriveRepoName('C:\\Users\\me\\Desktop\\Cool App')).toBe('Cool-App')
  })
})

describe('isGhAuthenticated', () => {
  it('is true for a logged-in status report', () => {
    expect(isGhAuthenticated('✓ Logged in to github.com account octocat (keyring)')).toBe(true)
    expect(isGhAuthenticated('  - Active account: true\n  - Token: gho_****')).toBe(true)
  })
  it('is false when not logged in, empty, or unrelated', () => {
    expect(isGhAuthenticated('You are not logged into any GitHub hosts.')).toBe(false)
    expect(isGhAuthenticated('')).toBe(false)
    expect(isGhAuthenticated('some unrelated output')).toBe(false)
  })
})

describe('parseRepoUrl', () => {
  it('extracts a github repo URL and strips a trailing .git', () => {
    expect(parseRepoUrl('Created repository octocat/hello on GitHub\nhttps://github.com/octocat/hello.git')).toBe(
      'https://github.com/octocat/hello'
    )
  })
  it('returns null when there is no URL', () => {
    expect(parseRepoUrl('nothing to see here')).toBeNull()
  })
})

describe('buildRepoCreateArgs', () => {
  it('builds a public create+push argv by default', () => {
    expect(buildRepoCreateArgs({ name: 'my-app' })).toEqual([
      'repo',
      'create',
      'my-app',
      '--public',
      '--source=.',
      '--remote=origin',
      '--push'
    ])
  })
  it('honours private and appends a description as its own argument', () => {
    const args = buildRepoCreateArgs({ name: 'secret', private: true, description: 'a b c' })
    expect(args).toContain('--private')
    expect(args).not.toContain('--public')
    expect(args.slice(-2)).toEqual(['--description', 'a b c'])
  })
})

describe('vercelNextSteps', () => {
  it('points at the concrete repo URL when known', () => {
    const lines = vercelNextSteps('https://github.com/octocat/hello')
    expect(lines.join('\n')).toContain('https://github.com/octocat/hello')
    expect(lines.join('\n')).toContain('vercel.com/new')
  })
  it('gives a generic import step when the URL is unknown, and never claims an auto-deploy', () => {
    const text = vercelNextSteps(null).join('\n')
    expect(text).toContain('vercel.com/new')
    expect(text).not.toMatch(/deployed to vercel/i)
  })
})
