import type { ChatMessage, CompletionChunk, CompletionOptions, ProviderSettings } from '@app/shared/types'
import type { ToolDef, ToolGate, ToolContext } from '@app/main/tools/registry'
import { createToolCallParser, toolCallBlock, toolResultBlock, type ToolCall } from '@app/main/tools/toolParser'
import { toErrorMessage, rateLimitRetryDelay } from '@app/main/providers/http'
import { fsTools } from '@app/main/tools/fs'
import { runCommandTool } from '@app/main/tools/command'
import { runCodeTool } from '@app/main/tools/runCode'
import { searchTools } from '@app/main/tools/search'
import { updatePlanTool } from '@app/main/tools/plan'
import { thinkTool } from '@app/main/tools/think'
import { webFetchTool, webSearchTool, wikiSearchTool } from '@app/main/tools/web'
import {
  extractNarratedFiles,
  looksLikeUnsavedCode,
  looksLikeContinuationRequest,
  looksLikeAnnouncedAction,
  looksLikeFalseLimitDeferral,
  looksLikeContentFreeReply,
  planHasPending,
  pendingPlanTitles,
  detectOscillation,
  researchStallVerdict,
  isSafeRelPath,
  MAX_CODE_PROSE_NUDGES,
  MAX_AUTO_CONTINUE,
  MAX_ANNOUNCED_ACTION,
  MAX_FALSE_LIMIT_DEFERRAL,
  MAX_EMPTY_START,
  MAX_PLAN_INCOMPLETE,
  OSCILLATION_WINDOW,
  OSCILLATION_MAX,
  RESEARCH_STALL_NUDGE
} from '@app/main/cowork-guards'
import type { Provider } from '@app/main/providers/provider'
import type { MytoCliConfig } from './config'
import * as tui from './tui'

declare const MYTO_CLI_VERSION: string
const CLI_VERSION = typeof MYTO_CLI_VERSION === 'string' ? MYTO_CLI_VERSION : '0.0.0'

/**
 * The CLI agent loop: the terminal twin of the desktop app's Cowork loop.
 *
 * One `run` is: stream a generation, parse ```myto:tool calls out of it (the SAME
 * parser the app uses), execute each via the CLI dispatcher (the same never-throws
 * contract as the app's `runTool`), feed the
 * result back as a ```myto:tool_result turn, and repeat until the model answers
 * with no call — guarded by the same stall heuristics (cowork-guards) so a weak
 * model is nudged onward instead of the run ending half-built.
 *
 * Deliberately a plain function (no Electron, no IPC): everything it needs rides
 * the arguments, so it is unit-testable with a fake provider.
 */

/** Turn budget — Cowork is effectively unbounded; keep a hard runaway ceiling. */
const MAX_TOOL_TURNS = 80

/** ANSI helpers. Disabled automatically when stdout is not a TTY (piped output). */
const isTty = process.stdout.isTTY === true
const c = {
  dim: (s: string): string => (isTty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string): string => (isTty ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string): string => (isTty ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string): string => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string): string => (isTty ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string): string => (isTty ? `\x1b[32m${s}\x1b[0m` : s)
}

/** "0.4s" / "1.2s" / "320ms" — compact duration for a step's right-hand meta. */
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${ms}ms`
}

/** A human verb + target for a tool call, shown as the step's label. */
function stepLabel(call: ToolCall): string {
  const rec = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>
  const path = typeof rec.path === 'string' ? rec.path : ''
  const s = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string) : '')
  switch (call.name) {
    case 'write_file': return `Writing ${c.bold(path)}`
    case 'edit_file': return `Editing ${c.bold(path)}`
    case 'delete_file': return `Deleting ${c.bold(path)}`
    case 'read_file': return `Reading ${path}`
    case 'list_dir': return `Inspecting ${path || 'folder'}`
    case 'find_files': return `Finding ${s('pattern') || s('query')}`
    case 'search_code': return `Searching ${s('pattern') || s('query')}`
    case 'run_command': return `Running ${c.bold(s('command'))}`
    case 'run_code': return 'Running code'
    case 'web_search': return `Searching web · ${s('query')}`
    case 'web_fetch': return `Fetching ${s('url')}`
    case 'wiki_search': return `Wiki · ${s('query')}`
    case 'update_plan': return 'Planning'
    case 'think': return 'Thinking'
    default: return call.name ?? 'tool'
  }
}

/** The lines a write/edit call wrote (for the diff card + the changes tally). */
function contentLines(call: ToolCall): string[] | null {
  const rec = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>
  return typeof rec.content === 'string' ? rec.content.split('\n') : null
}

/** Detect the dispatcher/sandbox failure strings so a bad step reads as failed. */
function stepFailed(result: string): boolean {
  return /(is outside the working folder|tool failed:|Unknown tool "|did not parse|not available right now|was refused)/i.test(
    result
  )
}

/** Render one executed step as a Claude-style bullet (plan → TODOs, writes → diff card). */
function renderStep(call: ToolCall, result: string, ms: number): void {
  const failed = stepFailed(result)
  const name = call.name
  if (name === 'update_plan') {
    process.stdout.write('\n' + tui.todos(parsePlanItems(call.input)) + '\n')
    return
  }
  if (name === 'think') {
    const rec = call.input as Record<string, unknown>
    const thought = typeof rec.thought === 'string' ? rec.thought : typeof rec.text === 'string' ? rec.text : ''
    process.stdout.write('\n' + tui.bullet('Thinking', thought.slice(0, 400), 'think') + '\n')
    return
  }
  const label = `${stepLabel(call)}${ms ? '  ' + fmtMs(ms) : ''}`
  const lines = contentLines(call)
  if ((name === 'write_file' || name === 'edit_file') && lines && !failed) {
    const rec = call.input as Record<string, unknown>
    const path = typeof rec.path === 'string' ? rec.path : 'file'
    process.stdout.write('\n' + tui.bullet(label, '', 'act') + '\n')
    const shown: tui.DiffLine[] = lines.slice(0, 14).map((t, i) => ({ n: i + 1, type: 'add', text: t }))
    if (lines.length > 14) shown.push({ type: 'ctx', text: `… +${lines.length - 14} more lines` })
    for (const l of tui.diffBlock(path, shown)) process.stdout.write(l + '\n')
    return
  }
  const cap = 240
  const body = result.length > cap ? `${result.slice(0, cap)} …` : result
  process.stdout.write('\n' + tui.bullet(label, body.split('\n').slice(0, 4).join('\n'), failed ? 'fail' : 'act') + '\n')
}

/** Coax a plan/update_plan payload into a {done,text} checklist, defensively. */
function parsePlanItems(input: unknown): { done: boolean; text: string }[] {
  const rec = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const arr = [rec.plan, rec.steps, rec.todos, rec.items].find(Array.isArray) as unknown[] | undefined
  if (arr) {
    return arr
      .map((it) => {
        if (typeof it === 'string') return { done: false, text: it }
        const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
        return { done: /done|complete|✓|checked/i.test(String(o.status ?? '')), text: String(o.title ?? o.text ?? o.step ?? '') }
      })
      .filter((x) => x.text)
  }
  const s = typeof rec.plan === 'string' ? rec.plan : typeof rec.content === 'string' ? rec.content : ''
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((l) => ({ done: /^[-*]\s*\[x\]/i.test(l), text: l.replace(/^[-*]\s*(\[.\]\s*)?/, '').replace(/^\d+[.)]\s*/, '') }))
}

export interface LoopOptions {
  provider: Provider
  modelId: string
  workspaceDir: string
  /** The user's task/prompt for this run. */
  task: string
  /** Extra system-prompt lines (e.g. a persona) — appended to the tool prompt. */
  systemExtra?: string
  /** Called with the final assistant text when the run finishes. */
  onDone?: (text: string) => void
  /** Signals a hard stop (user Ctrl-C during a turn). */
  signal?: AbortSignal
}

export interface LoopResult {
  finalText: string
  turns: number
  toolCalls: number
}

/** The CLI's tool gate: agentic (cowork) over the resolved workspace. */
function cliGate(settings: ProviderSettings, workspaceDir: string): ToolGate {
  return { settings, mode: 'cowork', workspaceDir }
}

/** The settings slice the tool implementations actually read. */
export function cliSettings(cfg: Omit<MytoCliConfig, 'source'>, workspaceDirArg?: string): ProviderSettings {
  const workspaceDir = workspaceDirArg ?? '.'
  return {
    activeProvider: cfg.activeProvider,
    ollama: cfg.ollama,
    gateway: cfg.gateway,
    modelName: cfg.modelId,
    modelId: cfg.modelId,
    fallbackModel: '',
    ui: { theme: 'dark', lastMode: 'cowork' },
    tools: { enabled: true, codeExecution: true },
    cowork: {
      workspaceDir,
      permissionMode: 'bypass',
      verifyCommand: '',
      planMode: false,
      hooks: { preToolUse: '', postToolUse: '' },
      terminalConsent: false,
      browserTarget: 'off'
    },
    mcpServers: [],
    skills: [],
    plugins: [],
    reasoningEffort: 'medium',
    outputStyle: 'default',
    nativeTools: false,
    researchAgentId: 'research-assistant',
    background: { keepAliveInTray: false, inboxEvery10min: false }
  }
}

/** The CLI tool catalogue, in advertisement order. */
export function cliTools(): readonly ToolDef[] {
  return [
    ...fsTools,
    ...searchTools,
    runCommandTool,
    runCodeTool,
    webFetchTool,
    webSearchTool,
    wikiSearchTool,
    updatePlanTool,
    thinkTool
  ]
}

/**
 * The CLI's dispatcher: the same contract as the app's `runTool` (never throws;
 * every failure resolves to a readable string the model recovers from) but over
 * the CLI's own catalogue — deliberately NOT the app's registry, which pulls in
 * the whole desktop toolset (officegen, browser, ffmpeg, …).
 */
export async function runCliTool(call: ToolCall, ctx: ToolContext, tools: readonly ToolDef[]): Promise<string> {
  if (!ctx.settings.tools.enabled) return 'Tool use is turned off.'
  if (call.error || !call.name) {
    return `That tool call did not parse (${call.error ?? 'unknown error'}). Re-issue it as one compact JSON object {"tool": "name", "input": { ... }} inside a myto:tool block.`
  }
  const tool = tools.find((t) => t.name === call.name)
  if (!tool) {
    return `Unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ')}.`
  }
  if (!tool.available(ctx)) {
    return `The "${call.name}" tool is not available right now.`
  }
  try {
    return await tool.run(call.input, ctx)
  } catch (err) {
    return `The "${call.name}" tool failed: ${toErrorMessage(err)}`
  }
}

/**
 * Build the system prompt: the same teaching prompt the registry emits (rebuilt
 * here against the CLI's catalogue) plus a CLI-specific preamble.
 */
export function cliSystemPrompt(gate: ToolGate, workspaceDir: string, systemExtra?: string): string {
  const tools = cliTools().filter((t) => t.available(gate))
  const catalogue = tools
    .map((t) => `- ${t.name} — ${t.description} Input example: ${t.usage}`)
    .join('\n')
  return [
    `You are Myto, an AI coding agent running in the user's terminal inside the project folder: ${workspaceDir}`,
    'Work directly on the files in this folder until the task is genuinely done, then give a short final summary. Never claim work you did not verify.',
    systemExtra ? `\n${systemExtra}` : '',
    '',
    'You can call tools. To call a tool, write ONE fenced block and then STOP — do not write the result yourself:',
    '',
    '```myto:tool',
    '{"tool": "<name>", "input": { ... }}',
    '```',
    '',
    'Rules:',
    '- Put the call on a single line of compact JSON between the fences.',
    '- Use EXACTLY this fenced `myto:tool` format — it is the only syntax that runs. Do NOT emit native tool markup such as `<invoke name="...">` / `<parameter name="...">`; that is not a tool call here.',
    '- After the block, output nothing and wait. The result comes back to you as a ```myto:tool_result block.',
    '- Read the result, then either call another tool or write your final answer to the user.',
    '- Never invent a tool result or claim you used a tool you did not.',
    '',
    'Available tools:',
    catalogue
  ]
    .filter(Boolean)
    .join('\n')
}

/** The context every tool call runs with: workspace-pinned, no approval prompts. */
function cliToolContext(settings: ProviderSettings, workspaceDir: string, signal: AbortSignal): ToolContext {
  return {
    settings,
    mode: 'cowork',
    workspaceDir,
    signal,
    onPlan: () => {}, // plan updates render via the tool's return string; nothing extra to do
    onCommand: (run) => {
      // Mirror shell runs so the user sees what executed, like the app's Terminal pane.
      process.stdout.write(c.yellow(`  ▸ $ ${run.command}\n`))
    }
  }
}

/**
 * Stream one generation with bounded retries (429 / transient 5xx), printing text
 * as it arrives. Returns the visible text plus any parsed tool calls.
 */
async function streamTurn(
  opts: LoopOptions,
  history: ChatMessage[],
  signal: AbortSignal
): Promise<{ visible: string; calls: ToolCall[]; truncated: boolean; error?: string }> {
  const parser = createToolCallParser()
  let visible = ''
  let truncated = false
  let lastError: string | undefined

  for (let attempt = 0; attempt < 4; attempt++) {
    visible = ''
    parser // one parser per attempt: a retried turn re-parses from scratch
    const p = createToolCallParser()
    const calls: ToolCall[] = []
    try {
      await opts.provider.streamCompletion(
        opts.modelId,
        history,
        (chunk: Omit<CompletionChunk, 'streamId'>) => {
          if (chunk.reasoning) return // thinking is not reply text
          if (chunk.delta) {
            const r = p.push(chunk.delta)
            if (r.text) {
              visible += r.text
              process.stdout.write(r.text)
            }
            if (r.call) calls.push(r.call)
          }
          if (chunk.toolCall) {
            // Native structured call (should not occur with nativeTools off, but
            // fold it in defensively so a drift never drops the work).
            calls.push({ block: toolCallBlock(chunk.toolCall.name, safeParse(chunk.toolCall.argsJson)), name: chunk.toolCall.name, input: safeParse(chunk.toolCall.argsJson), error: null })
          }
          if (chunk.done && chunk.truncated) truncated = true
          if (chunk.error) lastError = chunk.error
        },
        signal
      )
      // Drain anything still buffered (a call whose close fence landed in the
      // final delta, or a truncated open block → keep as text, not lost).
      const tail = p.flush()
      if (tail && !p.holdingBlock) {
        visible += tail
        process.stdout.write(tail)
      } else if (tail && p.holdingBlock) {
        // A truncated tool block: try to parse the partial as a call anyway —
        // the model may have finished the JSON before the fence closed.
        const partial = tail.replace(/^```myto:tool\s*/i, '').replace(/```[\s\S]*$/, '')
        const name = /"tool"\s*:\s*"([^"]+)"/.exec(partial)?.[1]
        if (name) {
          try {
            const input = JSON.parse(partial.slice(partial.indexOf('{'), partial.lastIndexOf('}') + 1))
            calls.push({ block: toolCallBlock(name, input), name, input, error: null })
            truncated = false
          } catch {
            truncated = true
          }
        } else {
          truncated = true
        }
      }
      if (lastError) return { visible, calls, truncated, error: lastError }
      return { visible, calls, truncated }
    } catch (err) {
      lastError = toErrorMessage(err)
      const wait = rateLimitRetryDelay(err, attempt)
      if (wait === null) return { visible, calls, truncated, error: lastError }
      process.stdout.write(c.yellow(`\n  (${lastError} — retrying in ${Math.round(wait / 1000)}s)\n`))
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  return { visible, calls: [], truncated, error: lastError }
}

/** JSON-parse-or-undefined helper for native-call args. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

/** Guard counters for one run (mirrors the app's cascade wiring). */
interface GuardState {
  plan: Array<{ title?: string; status?: string }>
  codeProseNudges: number
  autoContinues: number
  announcedActions: number
  falseLimits: number
  emptyStarts: number
  planNudges: number
  researchStreak: number
  recentSigs: string[]
  narrated: Map<string, string>
}

/**
 * Run the agent to completion. Returns the final assistant text.
 */
export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const workspaceDir = opts.workspaceDir
  const settings = cliSettings(
    {
      activeProvider: 'gateway',
      ollama: { baseUrl: 'http://localhost:11434' },
      gateway: { baseUrl: '', apiKey: '', authSchema: 'bearer', authHeaderName: 'Authorization' },
      modelId: opts.modelId
    },
    workspaceDir
  )
  const gate = cliGate(settings, workspaceDir)
  const signal = opts.signal ?? new AbortController().signal
  const ctx = cliToolContext(settings, workspaceDir, signal)

  const history: ChatMessage[] = [
    { role: 'system', content: cliSystemPrompt(gate, workspaceDir, opts.systemExtra) },
    { role: 'user', content: opts.task }
  ]

  const guards: GuardState = {
    plan: [],
    codeProseNudges: 0,
    autoContinues: 0,
    announcedActions: 0,
    falseLimits: 0,
    emptyStarts: 0,
    planNudges: 0,
    researchStreak: 0,
    recentSigs: [],
    narrated: new Map()
  }
  let toolCalls = 0
  let turns = 0
  const carried: ToolCall[] = []
  let finalText = ''
  const TOOLS = cliTools()
  // Per-run tally for the closing summary card.
  const changed = new Set<string>()
  let linesAdded = 0

  process.stdout.write(
    '\n' +
      tui.runHeader({
        version: CLI_VERSION,
        task: opts.task,
        model: opts.modelId,
        workspace: workspaceDir,
        byok: true
      }) +
      '\n'
  )

  while (turns < MAX_TOOL_TURNS) {
    turns++

    // Drain a previously batched call without re-generating (the app's RC-7).
    let call: ToolCall | undefined = carried.shift()
    let turnText = ''
    let truncated = false
    if (!call) {
      const r = await streamTurn(opts, history, signal)
      turnText = r.visible
      truncated = r.truncated
      if (r.error) {
        process.stdout.write(c.red(`\n${r.error}\n`))
        finalText = finalText || `Error: ${r.error}`
        break
      }
      if (r.calls.length > 0) {
        call = r.calls[0]
        carried.push(...r.calls.slice(1))
      }
      // Capture narrated files for the reconciliation path (RC-8).
      for (const f of extractNarratedFiles(turnText)) guards.narrated.set(f.path, f.content)
    }

    if (call) {
      // Execute. The dispatcher never throws; errors come back as strings.
      const t0 = Date.now()
      const result = await runCliTool(call, ctx, TOOLS)
      toolCalls++
      renderStep(call, result, Date.now() - t0)
      if ((call.name === 'write_file' || call.name === 'edit_file') && !stepFailed(result)) {
        const rec = call.input as Record<string, unknown>
        if (typeof rec.path === 'string') changed.add(rec.path)
        const cl = contentLines(call)
        if (cl) linesAdded += cl.length
      }
      // Track the call signature for oscillation detection.
      guards.recentSigs.push(`${call.name}:${JSON.stringify(call.input ?? {}).slice(0, 200)}`)
      if (guards.recentSigs.length > OSCILLATION_WINDOW * 2) guards.recentSigs.shift()
      // Building actions reset the research streak; read-only ones extend it.
      const tool = cliTools().find((t) => t.name === call?.name)
      const sideEffect = tool?.sideEffect
      if (sideEffect) {
        guards.researchStreak = 0
        guards.codeProseNudges = 0 // a real write resets the prose counter (RC-5)
      } else if (RESEARCH_STALL_NUDGE > 0 && call.name && ['list_dir','read_file','search_code','find_files','web_search','web_fetch','wiki_search'].includes(call.name)) {
        guards.researchStreak++
      }
      // Feed the result back exactly as the app does.
      history.push({ role: 'assistant', content: call.block })
      history.push({ role: 'user', content: toolResultBlock(call.name ?? 'tool', result) })
      continue
    }

    // No call this turn — the guard cascade decides continue vs finish.
    finalText = turnText || finalText

    if (truncated) {
      history.push({ role: 'assistant', content: turnText })
      history.push({
        role: 'user',
        content: 'Your reply was cut off at the output limit. Continue exactly where you stopped. If you were emitting a tool call, re-issue the FULL call now, splitting large file writes across several write_file/edit_file calls if needed.'
      })
      continue
    }

    // Plan reconciliation (RC-8): pending plan items whose file now exists on disk
    // are marked done without trusting the model to say so. Kept simple: the CLI
    // marks file-target steps done from real disk state and nudges on the rest.
    const pending = guards.plan.filter((t) => t.status !== 'done')
    if (pending.length > 0) {
      let reconciled = false
      for (const item of pending) {
        const m = /([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)/.exec(item.title ?? '')
        const path = m?.[1]
        if (path && isSafeRelPath(path) && guards.narrated.has(path)) {
          item.status = 'done'
          reconciled = true
        }
      }
      if (reconciled) continue
    }

    // Plan-completion gate (RC-1): a no-call turn with pending plan items is not a finish.
    if (planHasPending(guards.plan) && guards.planNudges < MAX_PLAN_INCOMPLETE) {
      guards.planNudges++
      history.push({ role: 'assistant', content: turnText })
      history.push({
        role: 'user',
        content: `Your plan still has pending items (${pendingPlanTitles(guards.plan).join('; ')}). Continue working on the next one now — call the tool that advances it, or update_plan if the plan changed. Do not stop until every item is done or genuinely impossible.`
      })
      continue
    }

    // Narrated code the model printed but never saved (RC-5): auto-persist.
    if (looksLikeUnsavedCode(turnText)) {
      const files = extractNarratedFiles(turnText)
      if (files.length > 0 && guards.codeProseNudges < MAX_CODE_PROSE_NUDGES) {
        guards.codeProseNudges++
        let wrote = false
        for (const f of files) {
          const synth: ToolCall = { block: '', name: 'write_file', input: { path: f.path, content: f.content }, error: null }
          const res = await runCliTool(synth, ctx, TOOLS)
          renderStep(synth, res, 0)
          if (!stepFailed(res)) {
            changed.add(f.path)
            linesAdded += f.content.split('\n').length
          }
          wrote = true
        }
        if (wrote) {
          guards.codeProseNudges = 0
          history.push({ role: 'assistant', content: turnText })
          history.push({ role: 'user', content: 'I saved the file(s) you printed in chat directly to disk. Continue with the next step of the task, or give your final summary if the work is complete.' })
          continue
        }
      }
      history.push({ role: 'assistant', content: turnText })
      history.push({
        role: 'user',
        content: 'You printed file contents as chat text instead of saving them. Use the write_file tool to actually create each file, then continue.'
      })
      continue
    }

    // Announced action ("Now I'm building…") with no call (RC-4).
    if (looksLikeAnnouncedAction(turnText) && guards.announcedActions < MAX_ANNOUNCED_ACTION) {
      guards.announcedActions++
      history.push({ role: 'assistant', content: turnText })
      history.push({ role: 'user', content: 'You announced a next step but made no tool call. Do it now with the appropriate tool.' })
      continue
    }

    // Continuation request ("Shall I continue?").
    if (looksLikeContinuationRequest(turnText) && guards.autoContinues < MAX_AUTO_CONTINUE) {
      guards.autoContinues++
      history.push({ role: 'assistant', content: turnText })
      history.push({ role: 'user', content: 'Yes — continue now. Do not ask again; keep working until the task is done.' })
      continue
    }

    // False limit / deferral ("I'll do it in the next turn…").
    if (looksLikeFalseLimitDeferral(turnText) && guards.falseLimits < MAX_FALSE_LIMIT_DEFERRAL) {
      guards.falseLimits++
      history.push({ role: 'assistant', content: turnText })
      history.push({ role: 'user', content: 'There is no such limit. Act now with the available tools — do not defer to a later turn.' })
      continue
    }

    // Research-only stall (distinct targets, nothing built).
    const verdict = researchStallVerdict(guards.researchStreak)
    if (verdict === 'stop') {
      finalText = finalText || 'Stopped: the run kept researching without building anything.'
      break
    }
    if (verdict === 'nudge') {
      history.push({ role: 'assistant', content: turnText })
      history.push({ role: 'user', content: 'Stop researching and act on what you have: write the file, run the command, or deliver the answer now.' })
      continue
    }

    // Content-free reply.
    if (looksLikeContentFreeReply(turnText) && guards.emptyStarts < MAX_EMPTY_START) {
      guards.emptyStarts++
      history.push({ role: 'assistant', content: turnText })
      history.push({ role: 'user', content: 'Your reply was empty. Take the first concrete action toward the goal now.' })
      continue
    }

    // Oscillation guard: the same call signature recurs too often.
    const osc = detectOscillation(guards.recentSigs, { window: OSCILLATION_WINDOW, maxRepeatsInWindow: OSCILLATION_MAX })
    if (osc) {
      finalText = finalText || `Stopped: repeated the same tool call (${osc.sig.split(':')[0]}) without progress.`
      break
    }

    // Otherwise this is the genuine final answer.
    finalText = turnText
    break
  }

  if (turns >= MAX_TOOL_TURNS && !finalText) {
    finalText = 'Stopped: reached the tool-turn ceiling before finishing.'
  }
  if (toolCalls > 0) {
    const tests = /(\d+\s*\/\s*\d+|all)\s+tests?\s+pass|tests?\s+pass(?:ed)?(?:\s*·?\s*\d+\/\d+)?/i.exec(finalText)?.[0]
    process.stdout.write(tui.summary({ files: changed.size, add: linesAdded, del: 0, turns, tests }) + '\n')
  }
  opts.onDone?.(finalText)
  return { finalText, turns, toolCalls }
}
