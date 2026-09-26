import { describe, it, expect, vi } from 'vitest'
import { askUserTool } from './ask'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ToolContext, ToolGate } from './registry'

const gate = (over: Partial<ToolGate> = {}): ToolGate => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir: '/work',
  ...over
})
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  ...gate(),
  signal: new AbortController().signal,
  askUser: vi.fn(async () => ['answer']),
  ...over
})

describe('askUserTool', () => {
  it('is read-only and available when tool use is on', () => {
    expect(askUserTool.sideEffect).toBeUndefined()
    expect(askUserTool.available(gate())).toBe(true)
    expect(askUserTool.available(gate({ settings: { ...DEFAULT_PROVIDER_SETTINGS, tools: { enabled: false, codeExecution: false } } }))).toBe(false)
  })

  it('needs a non-empty questions array', async () => {
    expect(await askUserTool.run({}, ctx())).toMatch(/needs a non-empty "questions"/i)
    expect(await askUserTool.run({ questions: [] }, ctx())).toMatch(/needs a non-empty "questions"/i)
    expect(await askUserTool.run({ questions: [{ notQuestion: 1 }] }, ctx())).toMatch(/needs a non-empty/i)
  })

  it('recovers a question from the mangled shapes weak models emit', async () => {
    // A bare string, a JSON string, a top-level {question}, {prompt}/{text}, an array
    // of plain strings, and {questions:"..."} must all raise a real question card
    // rather than the old "nothing was asked" dead end.
    const asked = async (input: unknown): Promise<string[]> => {
      const askUser = vi.fn<(qs: Array<{ question: string }>) => Promise<string[]>>(async () => ['ok'])
      await askUserTool.run(input, ctx({ askUser }))
      return askUser.mock.calls.length ? askUser.mock.calls[0][0].map((q) => q.question) : []
    }
    expect(await asked('Which framework?')).toEqual(['Which framework?'])
    expect(await asked('{"questions":[{"question":"Parsed?"}]}')).toEqual(['Parsed?'])
    expect(await asked({ question: 'Top-level?' })).toEqual(['Top-level?'])
    expect(await asked({ prompt: 'Via prompt?' })).toEqual(['Via prompt?'])
    expect(await asked({ questions: ['A?', 'B?'] })).toEqual(['A?', 'B?'])
    expect(await asked({ questions: 'Just a string?' })).toEqual(['Just a string?'])
  })

  it('proceeds gracefully when no interactive channel is available', async () => {
    const out = await askUserTool.run({ questions: [{ question: 'Which stack?' }] }, ctx({ askUser: undefined }))
    expect(out).toMatch(/best judgement|proceed/i)
  })

  it('asks and folds the answers into the result', async () => {
    const askUser = vi.fn<(qs: unknown[]) => Promise<string[]>>(async () => ['React + Vite', 'Dark'])
    const out = await askUserTool.run(
      {
        questions: [
          { header: 'Stack', question: 'Which stack?', options: ['React + Vite', 'Next.js'] },
          { question: 'Theme?' }
        ]
      },
      ctx({ askUser })
    )
    expect(askUser).toHaveBeenCalledOnce()
    const asked = askUser.mock.calls[0][0] as Array<{ header?: string; question: string; options?: string[] }>
    expect(asked).toHaveLength(2)
    expect(asked[0]).toMatchObject({ header: 'Stack', question: 'Which stack?', options: ['React + Vite', 'Next.js'] })
    expect(out).toMatch(/Which stack\?/)
    expect(out).toMatch(/React \+ Vite/)
    expect(out).toMatch(/Theme\?/)
    expect(out).toMatch(/Dark/)
  })

  it('caps at six questions and six options', async () => {
    const askUser = vi.fn(async (qs: unknown[]) => qs.map(() => 'x'))
    await askUserTool.run(
      {
        questions: Array.from({ length: 9 }, (_, i) => ({
          question: `Q${i}`,
          options: Array.from({ length: 9 }, (_, k) => `o${k}`)
        }))
      },
      ctx({ askUser })
    )
    const asked = askUser.mock.calls[0][0] as Array<{ options?: string[] }>
    expect(asked.length).toBeLessThanOrEqual(6)
    expect(asked[0].options!.length).toBeLessThanOrEqual(6)
  })
})
