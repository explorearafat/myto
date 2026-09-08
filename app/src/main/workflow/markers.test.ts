import { describe, expect, it } from 'vitest'
import { leadsWith, matchesAnyWord, matchesWord, wordMatches } from '@main/workflow/markers'

describe('matchesWord', () => {
  it('matches a marker standing as its own word', () => {
    expect(matchesWord('add a logout button', 'add')).toBe(true)
    expect(matchesWord('please build it', 'build')).toBe(true)
    expect(matchesWord('the ui is cramped', 'ui')).toBe(true)
  })

  it('does not match a marker buried inside another word', () => {
    // Each of these is a real misroute the old `includes()` matching produced.
    expect(matchesWord('tomake kono project dile', 'make')).toBe(false)
    expect(matchesWord('build a landing page', 'ui')).toBe(false)
    expect(matchesWord('a rapid prototype', 'api')).toBe(false)
    expect(matchesWord('use the latest version', 'test')).toBe(false)
    expect(matchesWord('the address parser', 'add')).toBe(false)
    expect(matchesWord('the author of the post', 'auth')).toBe(false)
  })

  it('still matches regular inflections of a verb stem', () => {
    expect(matchesWord('adding a button', 'add')).toBe(true)
    expect(matchesWord('added a button', 'add')).toBe(true)
    expect(matchesWord('builds cleanly', 'build')).toBe(true)
    expect(matchesWord('building the app', 'build')).toBe(true)
    // The dropped-`e` gerund a naive suffix list misses.
    expect(matchesWord('creating a model', 'create')).toBe(true)
    expect(matchesWord('renaming the file', 'rename')).toBe(true)
    expect(matchesWord('migrating the schema', 'migrate')).toBe(true)
    expect(matchesWord('changed the layout', 'change')).toBe(true)
    expect(matchesWord('writing the docs', 'write')).toBe(true)
  })

  it('treats a separator inside a compound as a word boundary', () => {
    expect(matchesWord('rewrite the front-end', 'front-end')).toBe(true)
    // A hyphenated or snake_cased compound still *mentions* its parts.
    expect(matchesWord('add a smoke-test', 'test')).toBe(true)
    expect(matchesWord('call run_test first', 'test')).toBe(true)
    // …but a plain word that merely contains the letters does not.
    expect(matchesWord('the latest build', 'test')).toBe(false)
  })

  it('handles markers with punctuation and digits', () => {
    expect(matchesWord('set up ci/cd for the repo', 'ci/cd')).toBe(true)
    expect(matchesWord('add an e2e check', 'e2e')).toBe(true)
    expect(matchesWord('what is a monad', 'what is')).toBe(true)
  })

  it('reports which markers matched', () => {
    expect(wordMatches('create the model and write the view', ['create', 'write', 'delete'])).toEqual([
      'create',
      'write'
    ])
    expect(matchesAnyWord('tomake ki korbe', ['make', 'build'])).toBe(false)
  })
})

describe('leadsWith', () => {
  it('matches a marker in leading position, followed by a boundary', () => {
    expect(leadsWith('hi', 'hi')).toBe(true)
    expect(leadsWith('hi there', 'hi')).toBe(true)
    expect(leadsWith('thanks!', 'thanks')).toBe(true)
    expect(leadsWith('good morning, sylor', 'good morning')).toBe(true)
  })

  it('tolerates a stretched letter, because people type "hii"', () => {
    expect(leadsWith('hii', 'hi')).toBe(true)
    expect(leadsWith('hiii tomake ekta kotha bolbo', 'hi')).toBe(true)
    expect(leadsWith('heyyy', 'hey')).toBe(true)
    expect(leadsWith('helloo there', 'hello')).toBe(true)
  })

  it('does not match a longer word that merely starts with the marker', () => {
    expect(leadsWith('hidden files in the tree', 'hi')).toBe(false)
    expect(leadsWith('type a docstring', 'ty')).toBe(false)
    expect(leadsWith('okra recipes', 'ok')).toBe(false)
  })

  it('does not match a marker away from the start', () => {
    expect(leadsWith('say hi to the parser', 'hi')).toBe(false)
  })
})
