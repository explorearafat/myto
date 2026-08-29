import { describe, it, expect } from 'vitest'
import { isGitAvailable, gitClone } from '@main/plugins/git'

describe('isGitAvailable', () => {
  it('resolves to a boolean without throwing', async () => {
    expect(typeof (await isGitAvailable())).toBe('boolean')
  })
})

describe('gitClone', () => {
  it('refuses an option-injection or blank URL before spawning git', async () => {
    expect(await gitClone('--upload-pack=evil', '/tmp/nope')).toEqual({
      ok: false,
      error: 'Refusing to clone an unsafe URL.'
    })
    expect((await gitClone('   ', '/tmp/nope')).ok).toBe(false)
  })
})
