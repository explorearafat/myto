import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSettings } from '@shared/types'

// The LLM fallback path builds a provider via providerFromSettings; intercept it
// so the ambiguous-prompt tests can script / fail the completion deterministically.
const { getCompletion } = vi.hoisted(() => ({ getCompletion: vi.fn() }))

vi.mock('@main/providers', () => ({
  providerFromSettings: () => ({
    streamCompletion: vi.fn(),
    getCompletion,
    listModels: vi.fn(),
    testConnection: vi.fn()
  })
}))

import {
  classifyComplexity,
  classifyComplexityHeuristic
} from '@main/workflow/orchestrator/complexity'

// providerFromSettings is fully mocked, so the settings content is never read.
const settings = {} as ProviderSettings

afterEach(() => {
  getCompletion.mockReset()
})

describe('classifyComplexityHeuristic', () => {
  it('rates a tiny one-file change simple', () => {
    expect(classifyComplexityHeuristic('fix the typo in the header')).toBe('simple')
  })

  it('rates broad-scope language complex', () => {
    expect(classifyComplexityHeuristic('refactor the entire codebase')).toBe('complex')
  })

  it('rates multi-domain work complex', () => {
    expect(
      classifyComplexityHeuristic('build a login API with a react frontend and a postgres database')
    ).toBe('complex')
  })

  it('rates many deliverables complex', () => {
    expect(
      classifyComplexityHeuristic('create the model, add the controller, and write the view')
    ).toBe('complex')
  })

  it('rates a single substantial-verb change medium (the ambiguous middle)', () => {
    expect(classifyComplexityHeuristic('refactor the settings module')).toBe('medium')
  })

  it('does not count a keyword buried inside another word', () => {
    // Every marker here used to fire on a substring: "ui" inside "build" and
    // "api" inside "rapid" made this four-word request look like frontend +
    // backend work, i.e. `complex`. It is one small thing.
    expect(classifyComplexityHeuristic('build a rapid prototype')).toBe('simple')
    // "add" inside "address".
    expect(classifyComplexityHeuristic('fix the address typo')).toBe('simple')
    // "make" inside the Banglish "tomake", "test" inside "latest".
    expect(classifyComplexityHeuristic('tomake latest branch ta dekhte hobe')).toBe('simple')
  })

  it('still counts inflected verbs as deliverables', () => {
    expect(
      classifyComplexityHeuristic('creating the model, adding the controller, writing the view')
    ).toBe('complex')
  })

  it('counts an auth or deploy domain named in full', () => {
    // "authentication"/"deployment" are not inflections of "auth"/"deploy", so
    // they are listed in their own right rather than caught by a substring.
    // Two domains is no longer complex on its own, but it is not simple either.
    expect(
      classifyComplexityHeuristic('add authentication and wire up the deployment pipeline')
    ).toBe('medium')
    // A third domain is breadth a person would recognise.
    expect(
      classifyComplexityHeuristic('add authentication, the deployment pipeline and a postgres schema')
    ).toBe('complex')
  })

  it('rates a named screen simple, however many domains its words touch', () => {
    // THE REGRESSION. "login page" is the auth domain ("login") plus the frontend
    // domain ("page"), and two domains used to mean `complex` — which meant a
    // nine-phase greenfield roadmap, a 20-section PROJECT.md and max reasoning
    // effort before a single line of the page. There is no way to ask for a login
    // page without naming both, so every such request was unsizeable.
    expect(classifyComplexityHeuristic('create a sign up and login page')).toBe('simple')
    expect(classifyComplexityHeuristic('add a settings screen')).toBe('simple')
    expect(classifyComplexityHeuristic('build the onboarding form')).toBe('simple')
  })

  it('does not treat a long explanation as a big job', () => {
    // The only route to `simple` used to require ≤14 words, so a request explained
    // carefully — or in Banglish, which is wordier — could never be small. This is
    // the prompt that produced the nine-phase answer, verbatim.
    const asked =
      'dekho amar folder e ekta logo er image ase, oi logo ta use kore sylor desktop app er ' +
      'jonno ekta sign up and login page creat korba, oikhane google and github er through ' +
      'login korar facility o add kore dii. login page jeno ekdom classic and dekhe jeno mone ' +
      'hoy kono human creat korese.'
    expect(classifyComplexityHeuristic(asked)).toBe('simple')
  })

  it('does not guess a whole product either way', () => {
    // No surface named and no stated breadth: `medium` is the honest offline
    // answer, rather than either a nine-phase build or a one-liner.
    expect(classifyComplexityHeuristic('build an e-commerce website')).toBe('medium')
  })

  it('stops being simple once too many surfaces are named', () => {
    expect(
      classifyComplexityHeuristic(
        'build the product page, the cart, the checkout and an admin dashboard'
      )
    ).not.toBe('simple')
  })
})

describe('classifyComplexity', () => {
  const verdict = (complexity: string, reason = 'because'): string =>
    JSON.stringify({ reason, complexity })

  it('asks the model to size every request', async () => {
    getCompletion.mockResolvedValue(verdict('medium'))
    expect(await classifyComplexity('add a btn', settings)).toBe('medium')
    expect(getCompletion).toHaveBeenCalledTimes(1)
  })

  it("honours the model's verdict over the keywords, in both directions", async () => {
    // THE POINT of the router. Sylor must not size the work itself: whatever the
    // rungs would have said, the model's answer is the answer.
    getCompletion.mockResolvedValue(verdict('simple'))
    expect(classifyComplexityHeuristic('refactor the entire codebase')).toBe('complex')
    expect(await classifyComplexity('refactor the entire codebase', settings)).toBe('simple')

    getCompletion.mockResolvedValue(verdict('complex'))
    expect(classifyComplexityHeuristic('fix the typo in the header')).toBe('simple')
    expect(await classifyComplexity('fix the typo in the header', settings)).toBe('complex')
  })

  it('grounds the decision in what the project already has', async () => {
    getCompletion.mockResolvedValue(verdict('simple'))
    await classifyComplexity('add a settings page', settings, undefined, {
      overview: 'Electron app with a working shell and 12 panes.'
    })
    const [, messages] = getCompletion.mock.calls[0]
    expect(messages[0].content).toContain('complexity router')
    expect(messages[1].content).toContain('add a settings page')
    expect(messages[1].content).toContain('working shell and 12 panes')
  })

  it('tells the model what choosing complex costs, so it does not reach for it', async () => {
    getCompletion.mockResolvedValue(verdict('simple'))
    await classifyComplexity('build the login page', settings)
    const system = getCompletion.mock.calls[0][1][0].content
    expect(system).toContain('nine-phase roadmap')
    expect(system).toContain('choose the smaller one')
  })

  it('says simple for an empty request without spending a call', async () => {
    expect(await classifyComplexity('   ', settings)).toBe('simple')
    expect(getCompletion).not.toHaveBeenCalled()
  })

  it('parses a fenced JSON response tolerantly', async () => {
    getCompletion.mockResolvedValue('```json\n{"reason":"one file","complexity":"simple"}\n```')
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('simple')
  })

  it('re-asks once when the reply is garbled, then falls back to the heuristic', async () => {
    getCompletion.mockResolvedValue('I think this is pretty involved, honestly.')
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('medium')
    expect(getCompletion).toHaveBeenCalledTimes(2)
  })

  it('takes the retry when only the first attempt is garbled', async () => {
    getCompletion.mockResolvedValueOnce('sorry, what?').mockResolvedValueOnce(verdict('complex'))
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('complex')
  })

  it('falls back to the heuristic when the provider is unreachable', async () => {
    getCompletion.mockRejectedValue(new Error('provider down'))
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('medium')
    expect(getCompletion).toHaveBeenCalledTimes(2)
  })

  it('does not retry after a Stop', async () => {
    const stopped = Object.assign(new Error('aborted'), { name: 'AbortError' })
    getCompletion.mockRejectedValue(stopped)
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('medium')
    expect(getCompletion).toHaveBeenCalledTimes(1)
  })

  it('does not call the provider at all when already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await classifyComplexity('refactor the settings module', settings, ctrl.signal)).toBe(
      'medium'
    )
    expect(getCompletion).not.toHaveBeenCalled()
  })
})
