import { describe, it, expect } from 'vitest'
import { requiresApproval, approvalDetail } from './approvals'
import type { ToolCall } from './toolParser'

const call = (input: unknown): ToolCall => ({ block: '', name: 'x', input, error: null })

describe('requiresApproval', () => {
  it('never asks for a read-only tool (no side effect)', () => {
    expect(requiresApproval('ask', undefined)).toBe(false)
    expect(requiresApproval('autoApprove', undefined)).toBe(false)
    expect(requiresApproval('bypass', undefined)).toBe(false)
  })

  it('ask: asks for both writes and code', () => {
    expect(requiresApproval('ask', 'write')).toBe(true)
    expect(requiresApproval('ask', 'exec')).toBe(true)
  })

  it('autoApprove: writes run silently, code still asks', () => {
    expect(requiresApproval('autoApprove', 'write')).toBe(false)
    expect(requiresApproval('autoApprove', 'exec')).toBe(true)
  })

  it('bypass: nothing asks', () => {
    expect(requiresApproval('bypass', 'write')).toBe(false)
    expect(requiresApproval('bypass', 'exec')).toBe(false)
  })
})

describe('approvalDetail', () => {
  it('prefers a file path', () => {
    expect(approvalDetail(call({ path: 'src/app.ts', content: 'x' }))).toBe('src/app.ts')
  })
  it('falls back to the language for code', () => {
    expect(approvalDetail(call({ language: 'python', code: '1' }))).toBe('python code')
  })
  it('is empty when there is nothing useful', () => {
    expect(approvalDetail(call({}))).toBe('')
    expect(approvalDetail(call(null))).toBe('')
  })
})
