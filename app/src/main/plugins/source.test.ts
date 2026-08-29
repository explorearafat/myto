import { describe, it, expect } from 'vitest'
import { normalizePluginSource, pluginSlug } from '@main/plugins/source'

describe('pluginSlug', () => {
  it('lowercases, strips .git, and dashes unsafe chars', () => {
    expect(pluginSlug('My Cool Plugin')).toBe('my-cool-plugin')
    expect(pluginSlug('awesome-skills.git')).toBe('awesome-skills')
    expect(pluginSlug('  Trailing--.')).toBe('trailing')
  })
})

describe('normalizePluginSource', () => {
  it('expands a bare owner/repo GitHub shorthand', () => {
    const s = normalizePluginSource('acme/cool-skills')
    expect(s).toEqual({
      ok: true,
      kind: 'git',
      url: 'https://github.com/acme/cool-skills.git',
      name: 'cool-skills'
    })
  })

  it('collapses a GitHub browser URL with a subpath to the repo root', () => {
    const s = normalizePluginSource('https://github.com/acme/cool-skills/tree/main/skills')
    expect(s).toMatchObject({
      ok: true,
      kind: 'git',
      url: 'https://github.com/acme/cool-skills.git',
      name: 'cool-skills'
    })
  })

  it('keeps an explicit .git clone URL and derives the name', () => {
    const s = normalizePluginSource('https://github.com/acme/cool-skills.git')
    expect(s).toMatchObject({ ok: true, url: 'https://github.com/acme/cool-skills.git', name: 'cool-skills' })
  })

  it('understands the github: scheme', () => {
    expect(normalizePluginSource('github:acme/cool-skills')).toMatchObject({
      ok: true,
      url: 'https://github.com/acme/cool-skills.git',
      name: 'cool-skills'
    })
  })

  it('passes an scp-style git remote through unchanged', () => {
    const s = normalizePluginSource('git@github.com:acme/cool-skills.git')
    expect(s).toMatchObject({ ok: true, kind: 'git', url: 'git@github.com:acme/cool-skills.git', name: 'cool-skills' })
  })

  it('clones a non-GitHub git host by URL', () => {
    const s = normalizePluginSource('https://gitlab.com/team/toolbox.git')
    expect(s).toMatchObject({ ok: true, kind: 'git', url: 'https://gitlab.com/team/toolbox.git', name: 'toolbox' })
  })

  it('recognizes a local folder path', () => {
    expect(normalizePluginSource('/home/me/my-plugin')).toMatchObject({
      ok: true,
      kind: 'local',
      path: '/home/me/my-plugin',
      name: 'my-plugin'
    })
    expect(normalizePluginSource('C:\\dev\\my-plugin')).toMatchObject({ ok: true, kind: 'local', name: 'my-plugin' })
    expect(normalizePluginSource('./relative/plugin')).toMatchObject({ ok: true, kind: 'local', name: 'plugin' })
  })

  it('rejects blank and unrecognized input with a friendly error', () => {
    expect(normalizePluginSource('   ')).toMatchObject({ ok: false })
    expect(normalizePluginSource('just some words here')).toMatchObject({ ok: false })
  })
})
