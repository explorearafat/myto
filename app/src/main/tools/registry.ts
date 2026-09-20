import type { ChatMode, ProviderSettings, ToolSideEffect } from '../../shared/types'
import { toErrorMessage } from '../providers/http'
import type { ToolCall } from './toolParser'
import { webFetchTool, webSearchTool, wikiSearchTool } from './web'
import { runCodeTool } from './runCode'
import { fsTools } from './fs'

/**
 * The tool registry: the catalogue of tools the chat can use, the dispatcher that
 * runs one ({@link runTool}), and the builder for the system prompt that teaches
 * the model the call protocol ({@link toolsSystemPrompt}).
 *
 * Availability is layered around a {@link ToolGate}. `settings.tools.enabled` is
 * the master switch — off means no tool is advertised or runnable at all. On top
 * of that each tool's own {@link ToolDef.available} gate applies against the gate:
 * that is how `run_code` stays hidden until the `codeExecution` opt-in is on, and
 * how the filesystem tools stay dormant outside Cowork mode (see ./fs.ts).
 */

/**
 * Everything a tool's availability decision depends on: the live settings, the
 * mode this turn runs in, and (for Cowork) the working folder. Passed to
 * {@link ToolDef.available}; extended by {@link ToolContext} at run time.
 */
export interface ToolGate {
  /** The live settings — read for gating (e.g. run_code) and endpoints. */
  settings: ProviderSettings
  /** How this turn runs — the filesystem tools require `cowork`. */
  mode: ChatMode
  /** The Cowork working folder, or null when none is chosen / not in Cowork. */
  workspaceDir: string | null
}

/** Ambient state a tool needs while running: the gate plus the cancel signal. */
export interface ToolContext extends ToolGate {
  /** Cancels the tool when the user hits Stop (chained to the stream's controller). */
  signal: AbortSignal
}

/** One tool the model can call through the text protocol. */
export interface ToolDef {
  /** The `"tool"` value the model writes; must be unique. */
  name: string
  /** One sentence shown to the model in the system prompt. */
  description: string
  /** A compact example `input` object, shown in the prompt. */
  usage: string
  /**
   * What this tool changes, if anything: 'write' (touches the filesystem), 'exec'
   * (runs code), or undefined for a read-only tool. Drives the Cowork permission
   * prompt — read-only tools never ask (see main/tools/approvals.ts).
   */
  sideEffect?: ToolSideEffect
  /** Whether this tool may be advertised/run under the given gate. */
  available(gate: ToolGate): boolean
  /** Execute the call; always resolves to a string (errors become messages). */
  run(input: unknown, ctx: ToolContext): Promise<string>
}

const ALL_TOOLS: readonly ToolDef[] = [
  webFetchTool,
  webSearchTool,
  wikiSearchTool,
  runCodeTool,
  ...fsTools
]

/** Lookup by name. Mutable only so tests can inject a fake tool; not written at runtime. */
export const TOOLS: Record<string, ToolDef> = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]))

/** The tools usable under `gate`: none when tool use is off, else each tool's own gate. */
export function availableTools(gate: ToolGate): ToolDef[] {
  if (!gate.settings.tools.enabled) return []
  return ALL_TOOLS.filter((t) => t.available(gate))
}

/**
 * Dispatch a parsed {@link ToolCall}. Never throws: a parse error, unknown name,
 * gated-off tool, or a failure inside the tool all resolve to a short message the
 * model reads back and can recover from — that is what keeps the agentic loop from
 * wedging on a bad call.
 */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  if (!ctx.settings.tools.enabled) return 'Tool use is turned off (Settings › Tools).'
  if (call.error || !call.name) {
    return `That tool call did not parse (${call.error ?? 'unknown error'}). Re-issue it as one compact JSON object {"tool": "name", "input": { ... }} inside a sylor:tool block.`
  }
  const tool = TOOLS[call.name]
  if (!tool) {
    return `Unknown tool "${call.name}". Available tools: ${availableTools(ctx).map((t) => t.name).join(', ') || '(none)'}.`
  }
  if (!tool.available(ctx)) {
    return `The "${call.name}" tool is not available right now — check Settings › Tools${
      ctx.mode !== 'cowork' ? ', or switch to Cowork and pick a working folder for the file tools' : ''
    }.`
  }
  try {
    return await tool.run(call.input, ctx)
  } catch (err) {
    return `The "${call.name}" tool failed: ${toErrorMessage(err)}`
  }
}

/**
 * Build the system prompt that teaches the call protocol and lists the currently
 * available tools. Returns null when no tools are available, so the caller can
 * omit the message entirely and leave plain-chat behaviour untouched.
 */
export function toolsSystemPrompt(gate: ToolGate): string | null {
  const tools = availableTools(gate)
  if (!tools.length) return null
  return [
    'You can call tools to get real information before you answer. To call a tool, write ONE fenced block and then STOP — do not write the result yourself:',
    '',
    '```sylor:tool',
    '{"tool": "<name>", "input": { ... }}',
    '```',
    '',
    'Rules:',
    '- Put the call on a single line of compact JSON between the fences.',
    '- After the block, output nothing and wait. The result comes back to you as a ```sylor:tool_result block.',
    '- Read the result, then either call another tool or write your final answer to the user.',
    '- Call a tool only when it genuinely helps: a fact you are unsure of, something current or time-sensitive, a page or source the user named, or code to run. Otherwise just answer directly.',
    '- Never invent a tool result or claim you used a tool you did not.',
    '',
    'Available tools:',
    ...tools.map((t) => `- ${t.name} — ${t.description} Input example: ${t.usage}`)
  ].join('\n')
}
