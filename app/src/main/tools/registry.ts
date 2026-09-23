import type { ChatMode, PreviewTarget, ProviderSettings, TodoItem, ToolSideEffect } from '../../shared/types'
import { toErrorMessage } from '../providers/http'
import type { ToolCall } from './toolParser'
import { webFetchTool, webSearchTool, wikiSearchTool } from './web'
import { runCodeTool } from './runCode'
import { fsTools } from './fs'
import { previewTool } from './preview'
import { updatePlanTool } from './plan'
import { searchTools } from './search'
import { runCommandTool } from './command'
import { spawnAgentTool } from './agent'
import { askUserTool } from './ask'
import { installConnectorTool, installSkillTool } from './install'

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
  /**
   * Show something in Myto's preview pane (Cowork). The `preview` tool calls this
   * to open/point the side pane; the stream loop turns it into a
   * {@link CompletionChunk.preview}. Optional — absent outside the streaming loop
   * (e.g. in unit tests), in which case the preview tool degrades to a plain note.
   */
  onPreview?: (target: PreviewTarget) => void
  /**
   * Publish the agent's working plan (Cowork). The `update_plan` tool calls this to
   * push the current checklist; the stream loop turns it into a
   * {@link CompletionChunk.todos}. Optional — absent outside the streaming loop.
   */
  onPlan?: (todos: TodoItem[]) => void
  /**
   * Run a focused read-only sub-task in a nested agent and resolve to its digest.
   * The `spawn_agent` tool calls this; the nested loop lives in provider-ipc.ts
   * (it needs the provider + model). Optional — absent outside the streaming loop,
   * where the tool degrades to a plain "not available" note.
   */
  delegate?: (task: string) => Promise<string>
  /**
   * Ask the user one or more clarifying questions and resolve to their answers (the
   * `ask_user` tool). Blocks the loop until the user answers. Optional — absent outside
   * the streaming loop, where the tool degrades to a note telling the model to proceed
   * with its best judgement.
   */
  askUser?: (questions: import('../../shared/types').AskQuestion[]) => Promise<string[]>
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
  runCommandTool,
  ...fsTools,
  ...searchTools,
  previewTool,
  updatePlanTool,
  spawnAgentTool,
  askUserTool,
  installConnectorTool,
  installSkillTool
]

/** Lookup by name. Mutable only so tests can inject a fake tool; not written at runtime. */
export const TOOLS: Record<string, ToolDef> = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]))

/**
 * Runtime-registered tools — the ones that come and go while the app runs: tools
 * exposed by a connected MCP server, an enabled skill, or an installed plugin. Kept
 * in a SEPARATE map from the built-in {@link TOOLS} catalogue on purpose: the
 * built-in surface is a fixed, snapshot-tested set, and a connector appearing must
 * never change it. These are merged into {@link availableTools} and {@link lookupTool}
 * at call time. Names are expected to be namespaced (e.g. `mcp__github__create_issue`)
 * so a connector can't shadow a built-in or another connector.
 */
const extensionTools = new Map<string, ToolDef>()

/** Register (or replace) a runtime tool. Called by the MCP manager as servers connect. */
export function registerExtensionTool(tool: ToolDef): void {
  extensionTools.set(tool.name, tool)
}

/** Remove runtime tools by name (a server disconnecting, a skill/plugin being disabled). */
export function unregisterExtensionTools(names: Iterable<string>): void {
  for (const name of names) extensionTools.delete(name)
}

/** Drop every runtime tool. Called on shutdown and when tests need a clean slate. */
export function clearExtensionTools(): void {
  extensionTools.clear()
}

/** The names of every currently-registered runtime tool. */
export function extensionToolNames(): string[] {
  return [...extensionTools.keys()]
}

/**
 * Look up a tool by name across the built-in catalogue and the runtime extensions.
 * The single resolution point so dispatch, side-effect gating, and the sub-agent
 * loop all see connectors, not just the built-ins.
 */
export function lookupTool(name: string): ToolDef | undefined {
  return TOOLS[name] ?? extensionTools.get(name)
}

/** The tools usable under `gate`: none when tool use is off, else each tool's own gate. */
export function availableTools(gate: ToolGate): ToolDef[] {
  if (!gate.settings.tools.enabled) return []
  const built = ALL_TOOLS.filter((t) => t.available(gate))
  if (extensionTools.size === 0) return built
  const ext = [...extensionTools.values()].filter((t) => t.available(gate))
  return [...built, ...ext]
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
    return `That tool call did not parse (${call.error ?? 'unknown error'}). Re-issue it as one compact JSON object {"tool": "name", "input": { ... }} inside a myto:tool block.`
  }
  const tool = lookupTool(call.name)
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
    '```myto:tool',
    '{"tool": "<name>", "input": { ... }}',
    '```',
    '',
    'Rules:',
    '- Put the call on a single line of compact JSON between the fences.',
    '- After the block, output nothing and wait. The result comes back to you as a ```myto:tool_result block.',
    '- Read the result, then either call another tool or write your final answer to the user.',
    '- Call a tool only when it genuinely helps: a fact you are unsure of, something current or time-sensitive, a page or source the user named, or code to run. Otherwise just answer directly.',
    '- Never invent a tool result or claim you used a tool you did not.',
    '',
    'Available tools:',
    ...tools.map((t) => `- ${t.name} — ${t.description} Input example: ${t.usage}`)
  ].join('\n')
}
