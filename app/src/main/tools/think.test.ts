import { describe, expect, it } from 'vitest'
import { thinkTool } from './think'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ToolContext } from './registry'

/**
 * The `think` tool is pure deliberation — the streaming loop (provider-ipc.ts) is what
 * turns a `think` call into a visible thinking block; the tool itself only validates its
 * input and acknowledges, as a fallback for contexts that don't special-case it.
 */
const ctx = (): ToolContext => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir: null,
  signal: new AbortController().signal
})

describe('think tool', () => {
  it('is read-only, so it never triggers an approval prompt', () => {
    expect(thinkTool.sideEffect).toBeUndefined()
  })

  it('is always available when tools are on, in Chat as well as Cowork', () => {
    expect(thinkTool.available({ settings: DEFAULT_PROVIDER_SETTINGS, mode: 'chat', workspaceDir: null })).toBe(true)
    expect(thinkTool.available({ settings: DEFAULT_PROVIDER_SETTINGS, mode: 'cowork', workspaceDir: null })).toBe(true)
  })

  it('needs a non-empty thought', async () => {
    expect(await thinkTool.run({}, ctx())).toMatch(/needs a non-empty "thought"/i)
    expect(await thinkTool.run({ thought: '   ' }, ctx())).toMatch(/needs a non-empty "thought"/i)
  })

  it('acknowledges a real thought and points back at acting on it', async () => {
    const out = await thinkTool.run({ thought: 'I will add the dep and re-run the build.' }, ctx())
    expect(out).toMatch(/next concrete action|final answer/i)
  })

  it('advertises a thought schema for the native function-calling path', () => {
    const schema = thinkTool.schema as { properties?: Record<string, unknown>; required?: string[] }
    expect(schema.properties).toHaveProperty('thought')
    expect(schema.required).toContain('thought')
  })
})
