import type { CoworkPermissionMode, ToolSideEffect } from '../../shared/types'
import type { ToolCall } from './toolParser'

/**
 * The permission decision for one Cowork tool call, kept pure so it can be unit
 * tested without the IPC dance around it (see provider-ipc.ts for the wiring).
 *
 * Read-only tools (no side effect) never ask. Otherwise the mode decides:
 *  - `bypass`      → never ask.
 *  - `autoApprove` → file writes/edits run silently; running code ('exec') still asks.
 *  - `ask`         → ask for anything with a side effect.
 */
export function requiresApproval(
  mode: CoworkPermissionMode,
  sideEffect: ToolSideEffect | undefined
): boolean {
  if (!sideEffect) return false
  if (mode === 'bypass') return false
  if (mode === 'autoApprove') return sideEffect === 'exec'
  return true
}

/**
 * A short human detail for the approval prompt: the target path for a file tool,
 * or the language for run_code. Empty string when nothing useful is available —
 * the prompt then leans on the tool name alone.
 */
export function approvalDetail(call: ToolCall): string {
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
  if (typeof input.path === 'string' && input.path.trim()) return input.path.trim()
  if (typeof input.language === 'string' && input.language.trim()) return `${input.language.trim()} code`
  return ''
}
