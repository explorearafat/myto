import { describe, it, expect } from 'vitest'
import { presentPlanTool } from './present-plan'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { PreviewTarget } from '../../shared/types'
import type { ToolContext, ToolGate } from './registry'

/**
 * present_plan is Feature 1's model-facing half: it renders a markdown plan into the
 * preview pane (so the user can read it) and returns a confirmation; the reply loop
 * then raises the approval gate. These tests pin the contract the loop relies on —
 * it emits a `markdown` PreviewTarget, degrades without a pane, and is drafted only
 * in the agentic modes.
 */

const gate = (over: Partial<ToolGate> = {}): ToolGate => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir: '/work',
  ...over
})

/** A context that records every preview target the tool emits. */
function recordingCtx(over: Partial<ToolContext> = {}): { ctx: ToolContext; previews: PreviewTarget[] } {
  const previews: PreviewTarget[] = []
  const ctx: ToolContext = {
    ...gate(),
    signal: new AbortController().signal,
    onPreview: (t) => previews.push(t),
    ...over
  }
  return { ctx, previews }
}

describe('presentPlanTool', () => {
  it('is available in both agentic modes, not in chat', () => {
    expect(presentPlanTool.available(gate({ mode: 'cowork' }))).toBe(true)
    expect(presentPlanTool.available(gate({ mode: 'research' }))).toBe(true)
    expect(presentPlanTool.available(gate({ mode: 'chat' }))).toBe(false)
  })

  it('carries no sideEffect, so the generic plan gate never fires before the plan renders', () => {
    expect(presentPlanTool.sideEffect).toBeUndefined()
  })

  it('renders the plan as a markdown preview target and confirms', async () => {
    const { ctx, previews } = recordingCtx()
    const out = await presentPlanTool.run({ plan: '## Plan\n\n1. Scaffold\n2. Build', title: 'Landing page' }, ctx)
    expect(previews).toHaveLength(1)
    expect(previews[0]).toEqual({ kind: 'markdown', markdown: '## Plan\n\n1. Scaffold\n2. Build', title: 'Landing page' })
    expect(out).toMatch(/waiting for the user to approve/i)
  })

  it('defaults the title to "Plan" when none is given', async () => {
    const { ctx, previews } = recordingCtx()
    await presentPlanTool.run({ plan: 'do the thing' }, ctx)
    expect(previews[0]).toMatchObject({ kind: 'markdown', title: 'Plan' })
  })

  it('asks for a plan string when it is missing or blank', async () => {
    const { ctx, previews } = recordingCtx()
    expect(await presentPlanTool.run({}, ctx)).toMatch(/needs a "plan"/i)
    expect(await presentPlanTool.run({ plan: '   ' }, ctx)).toMatch(/needs a "plan"/i)
    expect(previews).toHaveLength(0)
  })

  it('degrades to a note when there is no preview pane (no onPreview)', async () => {
    const ctx: ToolContext = { ...gate(), signal: new AbortController().signal }
    const out = await presentPlanTool.run({ plan: 'a plan' }, ctx)
    expect(out).toMatch(/no preview pane/i)
  })
})
