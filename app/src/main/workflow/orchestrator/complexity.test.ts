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
  classifyComplexityHeuristic,
  heuristicIsConfident
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
})

describe('heuristicIsConfident', () => {
  it('is confident on an obviously simple request', () => {
    expect(heuristicIsConfident('fix the typo in the header')).toBe(true)
  })

  it('is confident on an obviously complex request', () => {
    expect(heuristicIsConfident('refactor the entire codebase')).toBe(true)
  })

  it('is unsure on an ambiguous middle request', () => {
    expect(heuristicIsConfident('refactor the settings module')).toBe(false)
  })
})

describe('classifyComplexity', () => {
  it('short-circuits a trivially short prompt to simple without an LLM call', async () => {
    expect(await classifyComplexity('add a btn', settings)).toBe('simple')
    expect(getCompletion).not.toHaveBeenCalled()
  })

  it('uses the heuristic (no LLM call) when confident', async () => {
    expect(await classifyComplexity('refactor the entire codebase', settings)).toBe('complex')
    expect(getCompletion).not.toHaveBeenCalled()
  })

  it('spends an LLM call only on an ambiguous prompt and honours its verdict', async () => {
    getCompletion.mockResolvedValue('{"complexity":"complex"}')
    // The heuristic alone would say "medium"; the LLM overrides it to "complex".
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('complex')
    expect(getCompletion).toHaveBeenCalledTimes(1)
  })

  it('parses a fenced JSON response tolerantly', async () => {
    getCompletion.mockResolvedValue('```json\n{"complexity":"simple"}\n```')
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('simple')
  })

  it('falls back to the heuristic when the provider throws', async () => {
    getCompletion.mockRejectedValue(new Error('provider down'))
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('medium')
  })

  it('falls back to the heuristic when the response is unparseable', async () => {
    getCompletion.mockResolvedValue('I think this is pretty involved, honestly.')
    expect(await classifyComplexity('refactor the settings module', settings)).toBe('medium')
  })
})
