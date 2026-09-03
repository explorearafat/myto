import type { HookDefinition, HookEvent, HooksConfig } from '../../shared/types'

/**
 * Automation hooks (Phase 4) — the pure, Electron-free core.
 *
 * A hook is a user shell command fired at one of four lifecycle points around
 * the agent loop (see {@link HookEvent}). This module owns two concerns and
 * nothing else, so both are trivially unit-testable:
 *
 *  1. {@link matchHooks} — which configured hooks apply to a given event/tool.
 *  2. {@link runHooks}   — run the matched hooks through an *injected* command
 *     runner and, for `PreToolUse`, decide whether the tool is blocked.
 *
 * The command runner is injected (rather than importing the pty-backed
 * `runCommand` directly) so tests can drive scripted exit codes without a real
 * terminal, and so this file never depends on Electron or node-pty. The engine
 * supplies the real runner (a thin adapter over `terminal/runner.ts`).
 */

/** Default ceiling on a single hook's run time; a slow hook must not hang a run. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

/** Longest block reason fed back to the model, so hook output stays token-light. */
const MAX_REASON_LEN = 2_000

/**
 * Executes one hook command. Returns its exit code (null when it was aborted or
 * timed out) and captured output. Never rejects — a spawn failure is surfaced as
 * a non-zero exit so hook logic stays branch-free. Matches the relevant subset
 * of `terminal/runner.ts`'s `CommandRunResult`.
 */
export type HookCommandRunner = (
  command: string,
  env: Record<string, string>,
  timeoutMs: number
) => Promise<{ exitCode: number | null; output: string }>

/** What running an event's hooks decided. Only `PreToolUse` can set `blocked`. */
export interface HookRunOutcome {
  /** True when a `PreToolUse` hook exited non-zero (or timed out) — deny the tool. */
  blocked: boolean
  /** Human/model-facing reason for a block (the offending hook's output). */
  reason?: string
  /** How many hooks actually ran (for tests + telemetry). */
  ran: number
}

/**
 * Does `matcher` select `toolName`? An empty/absent matcher — or `*` — matches
 * everything (the common "run on every tool" case). Otherwise the matcher is a
 * regular expression tested against the tool name (Claude-Code semantics, e.g.
 * `write_file|edit_file`). An invalid regex degrades to an exact string compare
 * rather than throwing, so a typo can never crash a run.
 */
export function hookMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === '*') return true
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    return matcher === toolName
  }
}

/**
 * The hooks configured for `event` that apply here. For tool events
 * (`PreToolUse`/`PostToolUse`) each hook's `matcher` is tested against
 * `toolName`; for `Stop`/`UserPromptSubmit` there is no tool, so every hook for
 * that event applies (the matcher is ignored). Order is preserved so hooks fire
 * in author order.
 */
export function matchHooks(
  config: HooksConfig | undefined,
  event: HookEvent,
  toolName?: string
): HookDefinition[] {
  const defs = config?.[event]
  if (!defs || defs.length === 0) return []
  const isToolEvent = event === 'PreToolUse' || event === 'PostToolUse'
  if (!isToolEvent || toolName === undefined) return [...defs]
  return defs.filter((d) => hookMatches(d.matcher, toolName))
}

/** Clip + trim hook output into a compact block reason. */
function toReason(output: string, command: string): string {
  const trimmed = output.trim()
  const base = trimmed || `Blocked by a PreToolUse hook (\`${command}\`).`
  return base.length > MAX_REASON_LEN ? `${base.slice(0, MAX_REASON_LEN)}…` : base
}

/**
 * Run every hook that matches `event`/`toolName`, in order, via the injected
 * `run`. For `PreToolUse` a non-zero exit — including a null exit from a timeout
 * or abort — BLOCKS the tool (fail-closed) and short-circuits the remaining
 * pre-hooks: there is no point running more gates once one has denied the op.
 * For every other event nothing can block; hooks are fired for their side
 * effects (formatters, loggers, notifications) and their exit codes ignored.
 *
 * `env` is the base context (the engine builds `SYLOR_*` vars); it is passed to
 * each hook untouched. Never throws.
 */
export async function runHooks(
  config: HooksConfig | undefined,
  event: HookEvent,
  opts: { toolName?: string; env: Record<string, string> },
  run: HookCommandRunner
): Promise<HookRunOutcome> {
  const matched = matchHooks(config, event, opts.toolName)
  if (matched.length === 0) return { blocked: false, ran: 0 }

  const canBlock = event === 'PreToolUse'
  let ran = 0
  for (const def of matched) {
    const timeoutMs = def.timeoutMs && def.timeoutMs > 0 ? def.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS
    const { exitCode, output } = await run(def.command, opts.env, timeoutMs)
    ran += 1
    if (canBlock && exitCode !== 0) {
      return { blocked: true, reason: toReason(output, def.command), ran }
    }
  }
  return { blocked: false, ran }
}
