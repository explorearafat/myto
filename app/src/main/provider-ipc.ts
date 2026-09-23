import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  ApprovalDecision,
  ApprovalRequest,
  AskQuestion,
  QuestionRequest,
  ChatMessage,
  ChatMode,
  CompletionRequest,
  CompletionResult,
  GatewayConfig,
  ListModelsResult,
  OllamaConfig,
  PreviewTarget,
  ProviderKind,
  ProviderSettings,
  TestConnectionResult,
  TodoItem,
  ToolSideEffect
} from '../shared/types'
import { createProvider, providerFromSettings } from './providers'
import type { Provider } from './providers/provider'
import { toErrorMessage } from './providers/http'
import { getSettings, saveSettings } from './settings'
import {
  createStatusStripper,
  reasoningCaption,
  COWORK_SYSTEM_PROMPT,
  FILE_PROTOCOL_SYSTEM_PROMPT,
  STATUS_SYSTEM_PROMPT
} from './status'
import { availableTools, lookupTool, runTool, toolsSystemPrompt, type ToolGate } from './tools/registry'
import { ensureMytoDir, readJournal, recordGoal, recordToolAction } from './cowork-memory'
import { approvalDetail, requiresApproval } from './tools/approvals'
import { createToolCallParser, toolResultBlock, type ToolCall } from './tools/toolParser'

/**
 * How often, at most, to refresh the status caption from a reasoning model's
 * chain-of-thought. The model streams reasoning in tiny fragments (a real turn
 * measured ~1400 deltas over ~40s); rebuilding + sending a caption on every one
 * would spam IPC and the renderer for no visible gain. ~300ms reads as a live,
 * continuously-updating thought without the flicker.
 */
const REASONING_CAPTION_MS = 300

/**
 * Hard ceiling on tool round-trips in one reply. Each turn is a full model
 * generation, so this bounds cost and latency and — more importantly — guarantees
 * the agentic loop always terminates even if the model keeps asking for tools. On
 * the final turn tools are withheld and the model is told to answer with what it
 * has, so the reply never ends mid-loop.
 */
const MAX_TOOL_TURNS = 6

/**
 * The tool-round ceiling in Cowork mode. Real agentic work — scaffold a project,
 * read and write many files, install deps, run and fix a build — routinely needs
 * dozens of round-trips, so a small cap (it was 16) made Cowork give up before it
 * could finish anything substantial. This is now a high HARD ceiling that only
 * bounds a genuinely runaway loop; in-loop context compaction (below) keeps the
 * message history from growing without limit as the turns add up, and a stall guard
 * ends the loop early if the model stops making progress. The final turn still
 * withholds tools so the reply never ends mid-loop.
 */
const MAX_TOOL_TURNS_COWORK = 60

/**
 * When the running message history (system prompts + the growing tool round-trips)
 * exceeds roughly this many characters, the older middle of it is compacted into a
 * short summary before the next turn — see {@link compactHistory}. ~4 chars/token,
 * so ~90k chars ≈ ~22k tokens: comfortably inside even a modest context window while
 * leaving ample room for the next generation. A long Cowork task would otherwise
 * blow past the window after enough file reads and tool results.
 */
const COMPACT_OVER_CHARS = 90_000

/**
 * How many of the most recent messages to keep verbatim when compacting. The last
 * few round-trips are what the model is actively reasoning over, so they must stay
 * intact; everything older is what gets folded into the summary.
 */
const COMPACT_KEEP_RECENT = 6

/**
 * Stall guard: if the model issues this many IDENTICAL consecutive tool calls (same
 * name + input), the loop stops early rather than burning the whole budget spinning
 * on a call that isn't advancing the task. It is fed a nudge before the final count.
 */
const MAX_REPEAT_CALLS = 3

/** Read-only "look at the project" tools — churning on these without building is the
 *  classic weak-model stall (see the progress guard in the Cowork loop). */
const EXPLORE_TOOLS = new Set(['list_dir', 'read_file', 'search_code', 'find_files'])
/** After this many explorations with nothing built yet, force a "stop looking, build now". */
const MAX_EXPLORE_WITHOUT_BUILD = 2

/**
 * Session-level compaction ceiling, in estimated tokens. Unlike {@link COMPACT_OVER_CHARS}
 * (which folds the middle of an in-flight tool loop), this fires BEFORE a turn runs when
 * the *conversation itself* — the accumulated user/assistant turns loaded from the DB —
 * has grown large enough to crowd a big context window. Older turns are folded into one
 * summary so both plain chat and Cowork keep answering on very long threads. It is purely
 * in-flight: the summary is what the model sees this turn; the full transcript stays in
 * the database untouched. ~200k tokens is comfortably inside a modern large-context model
 * while leaving generous room for the reply.
 */
const SESSION_COMPACT_OVER_TOKENS = 200_000

/** Most recent conversation turns kept verbatim when a long session is compacted. */
const SESSION_KEEP_RECENT = 10

/** Tracks in-flight streams so the renderer can cancel them by id. */
const activeStreams = new Map<string, AbortController>()

/**
 * Approval prompts awaiting the user's answer, keyed by approvalId. When a Cowork
 * tool needs permission, the streaming loop parks a resolver here and blocks; the
 * renderer's decision (or a stream cancel) settles it. See {@link requiresApproval}.
 */
const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>()
let approvalCounter = 0

/** Pending `ask_user` questions, keyed by questionId; the renderer's answers settle each. */
const pendingQuestions = new Map<string, (answers: string[]) => void>()
let questionCounter = 0

/**
 * Registers all Phase 2 provider IPC handlers: settings read/write, model
 * listing, connection testing, and (streaming) completions. All network I/O
 * happens here in the main process.
 */
export function registerProviderIpc(): void {
  ipcMain.handle(IpcChannel.ProvidersGetSettings, (): ProviderSettings => getSettings())

  ipcMain.handle(
    IpcChannel.ProvidersSaveSettings,
    (_event, settings: ProviderSettings): ProviderSettings => saveSettings(settings)
  )

  ipcMain.handle(
    IpcChannel.ProvidersListModels,
    (_event, kind: ProviderKind, config: OllamaConfig | GatewayConfig): Promise<ListModelsResult> =>
      createProvider(kind, config).listModels()
  )

  ipcMain.handle(
    IpcChannel.ProvidersTestConnection,
    (
      _event,
      kind: ProviderKind,
      config: OllamaConfig | GatewayConfig,
      modelId: string
    ): Promise<TestConnectionResult> => createProvider(kind, config).testConnection(modelId)
  )

  ipcMain.handle(
    IpcChannel.ProvidersGetCompletion,
    async (_event, request: CompletionRequest): Promise<CompletionResult> => {
      try {
        const { provider, modelId, messages } = resolveRequest(request)
        const content = await provider.getCompletion(modelId, messages)
        return { ok: true, content }
      } catch (err) {
        return { ok: false, content: '', error: toErrorMessage(err) }
      }
    }
  )

  ipcMain.handle(
    IpcChannel.ProvidersStreamStart,
    async (event: IpcMainInvokeEvent, streamId: string, request: CompletionRequest): Promise<void> => {
      const controller = new AbortController()
      activeStreams.set(streamId, controller)
      const sender = event.sender

      const send = (chunk: {
        delta: string
        done: boolean
        error?: string
        status?: string
        approval?: ApprovalRequest
        question?: QuestionRequest
        preview?: PreviewTarget
        todos?: TodoItem[]
      }): void => {
        if (!sender.isDestroyed()) {
          sender.send(IpcChannel.ProvidersStreamChunk, { streamId, ...chunk })
        }
      }

      /** Forward a preview the `preview` tool raised to the renderer's pane (Cowork). */
      const onPreview = (target: PreviewTarget): void => {
        send({ delta: '', done: false, preview: target })
      }

      /** Forward the working plan the `update_plan` tool published (Cowork). */
      const onPlan = (todos: TodoItem[]): void => {
        send({ delta: '', done: false, todos })
      }

      /**
       * Raise an approval prompt for a side-effecting Cowork tool and wait for the
       * user's answer. Resolves to their decision, or 'deny' if the stream is
       * cancelled while waiting so a Stop never leaves the loop parked forever.
       */
      const requestApproval = (
        toolName: string,
        sideEffect: ToolSideEffect,
        detail: string
      ): Promise<ApprovalDecision> =>
        new Promise<ApprovalDecision>((resolve) => {
          if (controller.signal.aborted) {
            resolve('deny')
            return
          }
          const approvalId = `appr-${streamId}-${++approvalCounter}`
          const onAbort = (): void => settle('deny')
          const settle = (decision: ApprovalDecision): void => {
            controller.signal.removeEventListener('abort', onAbort)
            pendingApprovals.delete(approvalId)
            resolve(decision)
          }
          pendingApprovals.set(approvalId, settle)
          controller.signal.addEventListener('abort', onAbort, { once: true })
          send({ delta: '', done: false, approval: { approvalId, toolName, sideEffect, detail } })
        })

      /**
       * Ask the user clarifying questions (the `ask_user` tool) and resolve to their
       * answers. Mirrors {@link requestApproval}: raises a `question` chunk, blocks until
       * the renderer replies via ProvidersQuestionAnswer, and on cancel resolves to empty
       * answers so a Stop never parks the loop. Answers align with `questions` by index.
       */
      const requestQuestions = (questions: AskQuestion[]): Promise<string[]> =>
        new Promise<string[]>((resolve) => {
          if (controller.signal.aborted) {
            resolve([])
            return
          }
          const questionId = `q-${streamId}-${++questionCounter}`
          const onAbort = (): void => settle([])
          const settle = (answers: string[]): void => {
            controller.signal.removeEventListener('abort', onAbort)
            pendingQuestions.delete(questionId)
            resolve(answers)
          }
          pendingQuestions.set(questionId, settle)
          controller.signal.addEventListener('abort', onAbort, { once: true })
          send({ delta: '', done: false, question: { questionId, questions } })
        })

      const askUser = (questions: AskQuestion[]): Promise<string[]> => requestQuestions(questions)

      /** Side-effect kinds the user granted for the rest of this run ("Always allow"). */
      const grantedAlways = new Set<ToolSideEffect>()

      try {
        const { provider, modelId, messages } = resolveRequest(request)
        const settings = getSettings()
        const mode: ChatMode = request.mode ?? 'chat'

        // Session-level auto-compaction: a very long thread (loaded whole from the DB)
        // can crowd even a large context window. Before running the turn, if the
        // conversation is over the token ceiling, fold its older turns into one summary
        // so both plain chat and Cowork keep answering. Transient — the DB keeps the full
        // transcript; only what the model sees this turn is compacted. A brief status
        // caption surfaces it while the summarizer call runs.
        let convo = messages
        if (estimateTokens(convo) > SESSION_COMPACT_OVER_TOKENS) {
          send({ delta: '', done: false, status: 'Compacting earlier conversation to fit context…' })
          convo = await compactConversation(convo, provider, modelId, controller.signal)
          if (controller.signal.aborted) return
          send({ delta: '', done: false, status: '' })
        }
        // In Cowork, the filesystem tools are scoped to this folder; null when none
        // is set, which keeps those tools dormant (see tools/fs.ts + registry.ts).
        const workspaceDir = settings.cowork.workspaceDir.trim() || null
        const gate: ToolGate = { settings, mode, workspaceDir }
        const toolsPrompt = toolsSystemPrompt(gate)
        const maxToolTurns = mode === 'cowork' ? MAX_TOOL_TURNS_COWORK : MAX_TOOL_TURNS

        // Cowork project memory (.sylor/journal.md): read what earlier turns already
        // did in this folder so this turn continues instead of repeating. Best-effort.
        let coworkMemory = ''
        if (mode === 'cowork' && workspaceDir) {
          ensureMytoDir(workspaceDir)
          coworkMemory = readJournal(workspaceDir)
        }
        // Permission tier for side-effecting tools; only consulted in Cowork.
        const permissionMode = settings.cowork.permissionMode

        /**
         * Run a focused read-only sub-task in a nested agent (the `spawn_agent` tool).
         * Bound to this run's provider/model/gate and cancel signal. Returns a digest;
         * the sub-agent shares nothing with the visible stream, so it never touches the
         * UI or the main history except through the string it returns.
         */
        const delegate = (task: string): Promise<string> =>
          runNestedAgent(provider, modelId, gate, task, controller.signal)

        /**
         * Stream one model turn into the reply. Forwards <status> captions and
         * visible text exactly like the single-shot path always has; when
         * `parseTools` is set it also watches the visible text for a tool-call
         * fence and, on a complete one, stops the turn early and returns the parsed
         * call so the loop can run it. This helper never sends the terminal chunk —
         * the caller owns `done`, so the loop can decide between finishing, erroring,
         * and (on user cancel) sending nothing at all.
         *
         * The <status> handling mirrors the old single-call closure: a reasoning
         * model streams chain-of-thought in `chunk.reasoning` while the visible
         * reply stays empty and (measured) emits no <status> tags, so while only
         * reasoning flows we derive a throttled caption from it, then clear that
         * derived caption the moment real content arrives — but only when the
         * caption came from reasoning, leaving a non-reasoning model's genuine
         * <status> captions untouched.
         */
        const runTurn = async (
          turnHistory: ChatMessage[],
          parseTools: boolean
        ): Promise<{ visible: string; call: ToolCall | null; error?: string }> => {
          // Per-turn abort, chained to the outer user-cancel controller: aborting
          // `iter` ends just this generation (e.g. once a tool call is complete)
          // without tearing down the whole reply.
          const iter = new AbortController()
          const onOuterAbort = (): void => iter.abort()
          if (controller.signal.aborted) iter.abort()
          else controller.signal.addEventListener('abort', onOuterAbort, { once: true })

          const stripper = createStatusStripper()
          const toolParser = parseTools ? createToolCallParser() : null
          let reasoningText = ''
          let contentStarted = false
          let captionFromReasoning = false
          let lastReasoningEmit = 0
          let visible = ''
          let pendingCall: ToolCall | null = null

          // Route status-stripped text through the tool parser (when on): forward
          // the prose it releases, and capture the first complete tool call, ending
          // the turn. With tools off it is a straight passthrough.
          const emitText = (piece: string): void => {
            if (!piece) return
            if (toolParser) {
              const { text, call } = toolParser.push(piece)
              if (text) {
                visible += text
                send({ delta: text, done: false })
              }
              if (call && !pendingCall) {
                pendingCall = call
                iter.abort()
              }
            } else {
              visible += piece
              send({ delta: piece, done: false })
            }
          }

          const onProviderChunk = (chunk: {
            delta: string
            done: boolean
            reasoning?: string
          }): void => {
            if (pendingCall) return // call already found — ignore the tail
            if (chunk.reasoning && !contentStarted) {
              reasoningText += chunk.reasoning
              const now = Date.now()
              if (now - lastReasoningEmit >= REASONING_CAPTION_MS) {
                const caption = reasoningCaption(reasoningText)
                if (caption) {
                  lastReasoningEmit = now
                  captionFromReasoning = true
                  send({ delta: '', done: false, status: caption })
                }
              }
            }
            if (chunk.delta) {
              const { text, statuses } = stripper.push(chunk.delta)
              for (const status of statuses) {
                captionFromReasoning = false
                send({ delta: '', done: false, status })
              }
              if (text) {
                if (!contentStarted) {
                  contentStarted = true
                  if (captionFromReasoning) send({ delta: '', done: false, status: '' })
                }
                emitText(text)
              }
            }
            // `done` is intentionally not handled here — the loop sends it.
          }

          try {
            await provider.streamCompletion(modelId, turnHistory, onProviderChunk, iter.signal, {
              reasoningEffort: settings.reasoningEffort
            })
          } catch (err) {
            controller.signal.removeEventListener('abort', onOuterAbort)
            if (controller.signal.aborted) return { visible, call: null } // user cancel
            if (pendingCall) return { visible, call: pendingCall } // ended early for a tool
            return { visible, call: null, error: toErrorMessage(err) }
          }
          controller.signal.removeEventListener('abort', onOuterAbort)

          // Natural end: flush the status stripper's tail through the tool parser,
          // then release anything the tool parser was still holding (a truncated or
          // never-closed fence) as plain text so nothing the model wrote is lost.
          const tail = stripper.flush()
          if (tail) emitText(tail)
          if (toolParser && !pendingCall) {
            const leftover = toolParser.flush()
            if (leftover) {
              visible += leftover
              send({ delta: leftover, done: false })
            }
          }
          return { visible, call: pendingCall }
        }

        // Base system prompts: <status> narration + the file-card protocol. Applied
        // only here, on the interactive stream — the non-streaming getCompletion
        // path (auto-titles) never receives them.
        const baseSystem: ChatMessage[] = [
          { role: 'system', content: STATUS_SYSTEM_PROMPT },
          { role: 'system', content: FILE_PROTOCOL_SYSTEM_PROMPT },
          // Cowork turns the assistant into a goal-driven agent over the folder.
          ...(mode === 'cowork'
            ? [{ role: 'system' as const, content: COWORK_SYSTEM_PROMPT }]
            : []),
          // Inject the project journal so the agent continues rather than repeats.
          ...(coworkMemory
            ? [
                {
                  role: 'system' as const,
                  content:
                    'PROJECT MEMORY — you have worked in this folder before. Here is your journal of what you already did (most recent last). Do NOT repeat these steps; continue from where this leaves off:\n\n' +
                    coworkMemory
                }
              ]
            : [])
        ]

        // Tools off (or none available): the original single-shot behaviour, so a
        // plain-chat reply is byte-for-byte what it was before tools existed.
        if (!toolsPrompt) {
          const { error } = await runTurn([...baseSystem, ...convo], false)
          if (controller.signal.aborted) return
          send(error ? { delta: '', done: true, error } : { delta: '', done: true })
          return
        }

        // Tools on: the bounded agentic loop. History grows with each round-trip so
        // the model sees its own call and the result it got back.
        const history: ChatMessage[] = [
          ...baseSystem,
          { role: 'system', content: toolsPrompt },
          ...convo
        ]

        // The user's actual ask — the latest user turn. Restated on every tool-result
        // turn below so a long agentic loop (especially on a smaller model) keeps the
        // goal in view instead of latching onto the freshest tool output. Without this,
        // an early empty/sparse tool result (e.g. list_dir on a new folder) reads as
        // "nothing to do" and the model abandons the task mid-loop. Trimmed so a huge
        // pasted turn can't blow up every subsequent message.
        const lastUser = [...convo].reverse().find((m) => m.role === 'user')
        const goal = (lastUser?.content ?? '').trim()
        const goalReminder = goal
          ? `Remember, the user's request is: "${goal.length > 500 ? `${goal.slice(0, 500)}…` : goal}"\n\n`
          : ''
        // Log this turn's goal to the project journal (Cowork memory).
        if (mode === 'cowork' && workspaceDir && goal) recordGoal(workspaceDir, goal)

        // Everything up to here — the system prompts and the original conversation —
        // is the fixed head that compaction never touches; the loop only appends after
        // it. Captured so {@link compactHistory} knows where the compactible middle
        // (the accumulated tool round-trips) begins.
        const baseLen = history.length

        // Stall guard state: the signature of the last tool call and how many times in
        // a row it has repeated identically (see MAX_REPEAT_CALLS).
        let lastCallSig = ''
        let repeatCount = 0

        // Progress guard (Cowork): a weak model tends to loop on read-only exploration
        // (list_dir/read_file) while only narrating "I'll build…", never actually writing
        // a file. Track how many times it has explored without producing anything, so we
        // can escalate from a hint to a hard "stop looking, build now" directive.
        let buildsMade = 0
        let exploreStreak = 0

        for (let turn = 0; turn < maxToolTurns; turn++) {
          // Keep the running history inside the context window on long tasks: once it
          // grows past the threshold, fold the older middle into a short summary so the
          // loop can continue instead of eventually overflowing the model. Cowork only —
          // a plain-chat tool loop is short and never reaches this.
          if (mode === 'cowork' && historyChars(history) > COMPACT_OVER_CHARS) {
            await compactMiddle(history, baseLen, provider, modelId, controller.signal)
            if (controller.signal.aborted) return
          }

          const { visible, call, error } = await runTurn(history, true)
          if (controller.signal.aborted) return
          if (error) {
            send({ delta: '', done: true, error })
            return
          }
          if (!call) {
            send({ delta: '', done: true })
            return
          }

          // A tool was called. The parser consumed the call block (it never
          // reached the reply), so write it to the transcript now, run the tool,
          // then stream the result block onto the same card.
          const toolName = call.name ?? 'tool'
          send({ delta: `\n${call.block}\n`, done: false, status: `Running ${toolName}` })

          // Stall guard: if the model keeps issuing the same call, it is spinning, not
          // progressing. Track the streak; once it hits the limit, stop the loop early
          // (fall through to the closing turn) instead of burning the whole budget.
          const callSig = `${call.name ?? ''}:${JSON.stringify(call.input ?? null)}`
          if (callSig === lastCallSig) repeatCount++
          else {
            lastCallSig = callSig
            repeatCount = 1
          }
          if (repeatCount >= MAX_REPEAT_CALLS) {
            send({ delta: toolResultBlock(toolName, `Stopped: "${toolName}" was called ${repeatCount} times identically without progress.`), done: false })
            break
          }

          // Permission gate: side-effecting tools in Cowork may need the user's OK,
          // unless already granted "always" for this run.
          const sideEffect = call.name ? lookupTool(call.name)?.sideEffect : undefined
          let result: string
          if (
            mode === 'cowork' &&
            requiresApproval(permissionMode, sideEffect) &&
            !(sideEffect && grantedAlways.has(sideEffect))
          ) {
            send({ delta: '', done: false, status: `Waiting for your approval` })
            const decision = await requestApproval(
              toolName,
              sideEffect as ToolSideEffect,
              approvalDetail(call)
            )
            if (controller.signal.aborted) return
            if (decision === 'allow_always' && sideEffect) grantedAlways.add(sideEffect)
            result =
              decision === 'deny'
                ? `The user denied permission to run "${toolName}". Do not retry it; continue without it, or tell the user what you would need to proceed.`
                : await runTool(call, { ...gate, signal: controller.signal, onPreview, onPlan, delegate, askUser })
          } else {
            result = await runTool(call, { ...gate, signal: controller.signal, onPreview, onPlan, delegate, askUser })
          }
          if (controller.signal.aborted) return
          send({ delta: toolResultBlock(toolName, result), done: false })
          // Journal meaningful actions (writes/edits/deletes/commands/code) so the next
          // turn knows they happened and doesn't repeat them (Cowork memory).
          if (mode === 'cowork' && workspaceDir) recordToolAction(workspaceDir, call, result)

          // Progress guard: count real building (writes/edits/code/commands) vs. read-only
          // exploration. If the model keeps looking without ever building, escalate from
          // the gentle nudge to a hard directive that forbids more exploration.
          if (sideEffect) {
            buildsMade++
            exploreStreak = 0
          } else if (call.name && EXPLORE_TOOLS.has(call.name)) {
            exploreStreak++
          } else if (call.name === 'update_plan') {
            exploreStreak = 0 // planning is progress, not stalling
          }
          const stalling = mode === 'cowork' && buildsMade === 0 && exploreStreak >= MAX_EXPLORE_WITHOUT_BUILD
          const progressDirective = stalling
            ? `\n\nSTOP EXPLORING. You have inspected the folder ${exploreStreak} times and built NOTHING yet. The folder does not need more looking. Your VERY NEXT action MUST be to actually build: call update_plan with the concrete steps, then write_file to create the first real file. Do NOT call list_dir, read_file, search_code, or find_files again until files exist. Do not just say what you will do — do it now with a tool call.`
            : ''

          // Record the round-trip for the model's next turn. The assistant turn is
          // its visible prose plus the call block; the tool result comes back as a
          // user turn (providers accept only user/assistant/system roles).
          const assistantTurn = (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block
          history.push({ role: 'assistant', content: assistantTurn })
          history.push({
            role: 'user',
            content: `Tool result for ${toolName}:\n${result}\n\n${goalReminder}Keep going until the request is fully done: call another tool if you still need to, or give your final answer once it is complete. Do not repeat an identical call. An empty or sparse result (e.g. a near-empty folder) is a starting point, not a reason to stop — build what was asked for.${progressDirective}`
          })
        }

        // Budget spent: force a closing turn with tools withheld so the reply never
        // ends mid-loop.
        send({ delta: '', done: false, status: 'Finishing up' })
        history.push({
          role: 'system',
          content:
            'You have reached the tool-use limit for this reply. Do not call any more tools — answer the user now using what you already have.'
        })
        const final = await runTurn(history, false)
        if (controller.signal.aborted) return
        send(final.error ? { delta: '', done: true, error: final.error } : { delta: '', done: true })
      } catch (err) {
        // AbortError from a user cancel isn't a real failure.
        if (!controller.signal.aborted) send({ delta: '', done: true, error: toErrorMessage(err) })
      } finally {
        activeStreams.delete(streamId)
      }
    }
  )

  ipcMain.on(IpcChannel.ProvidersStreamCancel, (_event, streamId: string) => {
    activeStreams.get(streamId)?.abort()
    activeStreams.delete(streamId)
  })

  ipcMain.on(
    IpcChannel.ProvidersApprovalDecision,
    (_event, approvalId: string, decision: ApprovalDecision) => {
      // Settling removes the entry; a stray/duplicate decision is a harmless no-op.
      pendingApprovals.get(approvalId)?.(decision)
    }
  )

  ipcMain.on(
    IpcChannel.ProvidersQuestionAnswer,
    (_event, questionId: string, answers: string[]) => {
      // Settling removes the entry; a stray/duplicate answer is a harmless no-op.
      pendingQuestions.get(questionId)?.(Array.isArray(answers) ? answers : [])
    }
  )
}

/** Total characters across a message history — a cheap proxy for token pressure. */
function historyChars(history: ChatMessage[]): number {
  let n = 0
  for (const m of history) n += m.content.length
  return n
}

/**
 * Rough token estimate for a conversation. Uses the same ~4 chars/token proxy the rest
 * of the codebase does (no tokenizer is bundled), which is close enough to decide when a
 * thread is large enough to compact.
 */
function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(historyChars(messages) / 4)
}

/**
 * The instruction that shapes a whole-conversation compaction summary. Unlike
 * {@link COMPACT_INSTRUCTION} (which summarizes an agent's tool transcript), this folds the
 * earlier part of a back-and-forth chat, so it's told to preserve the human-facing thread:
 * facts, decisions, questions asked, code shared, and anything the assistant committed to.
 */
const SESSION_COMPACT_INSTRUCTION =
  'You are compacting the earlier part of a chat conversation so it fits the context window. Summarize the messages below into a concise, factual note that preserves everything the assistant needs to keep the conversation coherent: key facts and details the user gave, decisions made, questions raised and answered, important code or file paths shared, and anything the assistant promised or is mid-way through. Use short bullet points or brief paragraphs. Do not add commentary and do not address anyone — this is an internal memory note.'

/**
 * Fold the older part of a long conversation into a single summary turn so a very long
 * thread keeps fitting the model's context. Returns a NEW message array (the input is not
 * mutated): the most recent {@link SESSION_KEEP_RECENT} turns are kept verbatim and
 * everything older is replaced by one summary turn in front of them. Purely in-flight —
 * the caller passes the result to the model for this turn only; the database still holds
 * the full transcript.
 *
 * The summary is written by the model (a one-shot {@link Provider.getCompletion}); if that
 * call fails or is cancelled the original messages are returned unchanged, so compaction
 * can only ever help, never wedge a reply.
 */
async function compactConversation(
  messages: ChatMessage[],
  provider: Provider,
  modelId: string,
  signal: AbortSignal
): Promise<ChatMessage[]> {
  const keepFrom = Math.max(0, messages.length - SESSION_KEEP_RECENT)
  const older = messages.slice(0, keepFrom)
  const recent = messages.slice(keepFrom)
  // Not worth a summarizer round-trip unless there's a real block of older turns to fold.
  if (older.length < 2) return messages

  const TRANSCRIPT_CAP = 60_000
  let transcript = older.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
  if (transcript.length > TRANSCRIPT_CAP) {
    transcript = `…[earliest turns truncated]\n\n${transcript.slice(-TRANSCRIPT_CAP)}`
  }

  let summaryText = ''
  try {
    summaryText = (
      await provider.getCompletion(
        modelId,
        [
          { role: 'system', content: SESSION_COMPACT_INSTRUCTION },
          { role: 'user', content: transcript }
        ],
        undefined,
        signal
      )
    ).trim()
  } catch {
    return messages
  }
  if (signal.aborted) return messages

  const note =
    summaryText ||
    `[${older.length} earlier messages were summarized here to fit the context window.]`
  const summaryTurn: ChatMessage = {
    role: 'user',
    content: `Summary of earlier conversation (older messages were compacted to fit the context window):\n${note}`
  }
  return [summaryTurn, ...recent]
}

/**
 * The instruction that shapes a compaction summary. Asked for a compact, factual
 * record of the work so far — what was done, what was learned, what remains — so the
 * loop can continue from it without the raw transcript.
 */
const COMPACT_INSTRUCTION =
  'You are compacting an AI agent\'s working transcript to save space. Summarize the steps below as a tight, factual progress note the agent can keep working from. Include: files created/edited (with paths), commands run and their key outcomes, important facts discovered, and what still appears to be left. Use short bullet points. Do not add commentary, do not address the user — this is an internal note.'

/**
 * Fold the older middle of a Cowork tool loop's history into a single summary so the
 * running context stays inside the model's window on long tasks. Mutates `history`
 * in place: everything from `baseLen` (just past the fixed system+conversation head)
 * up to the last {@link COMPACT_KEEP_RECENT} messages is replaced by one summary
 * turn. The recent tail is kept verbatim because that is what the model is actively
 * reasoning over.
 *
 * The summary is written by the model itself (a one-shot {@link Provider.getCompletion});
 * if that call fails or is offline, a deterministic placeholder note is spliced in
 * instead, so compaction never wedges the loop — it just degrades to a terse marker.
 */
async function compactMiddle(
  history: ChatMessage[],
  baseLen: number,
  provider: Provider,
  modelId: string,
  signal: AbortSignal
): Promise<void> {
  const end = history.length - COMPACT_KEEP_RECENT
  const middleCount = end - baseLen
  // Need a worthwhile middle to bother compacting (at least a couple of round-trips).
  if (middleCount < 3) return

  // Build the transcript to summarize, capped so the summarizer call itself stays
  // small even though the history it is folding is large: take the tail of the joined
  // text (the most recent, most relevant middle) if it runs long.
  const TRANSCRIPT_CAP = 40_000
  let transcript = history
    .slice(baseLen, end)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
  if (transcript.length > TRANSCRIPT_CAP) {
    transcript = `…[earlier steps truncated]\n\n${transcript.slice(-TRANSCRIPT_CAP)}`
  }

  let summaryText = ''
  try {
    summaryText = (
      await provider.getCompletion(
        modelId,
        [
          { role: 'system', content: COMPACT_INSTRUCTION },
          { role: 'user', content: transcript }
        ],
        undefined,
        signal
      )
    ).trim()
  } catch {
    summaryText = ''
  }
  if (signal.aborted) return

  const note =
    summaryText ||
    `[${middleCount} earlier tool steps were omitted here to save space. Continue from the recent steps below and the user's request.]`
  const summaryTurn: ChatMessage = {
    role: 'user',
    content: `Progress so far (summary of earlier steps):\n${note}`
  }
  // Replace the middle with the single summary turn.
  history.splice(baseLen, middleCount, summaryTurn)
}

/** Bounded turns for a delegated sub-agent — it is a focused sub-task, not a full run. */
const NESTED_AGENT_MAX_TURNS = 8
/** Cap on the digest a sub-agent hands back, so one delegation can't bloat the main context. */
const NESTED_DIGEST_CAP = 6000
/** Tools a sub-agent must never touch: side effects, and the UI/meta tools that make no headless sense. */
const SUBAGENT_EXCLUDED = new Set(['preview', 'update_plan', 'spawn_agent', 'ask_user'])

/**
 * Run a delegated read-only sub-task to completion and return its findings as a
 * string (the `spawn_agent` tool's payload). This is a small, self-contained agentic
 * loop that never touches the visible stream: it drives the model turn-by-turn with
 * {@link Provider.getCompletion} (not the streaming path), detects a tool call in each
 * full response, runs it, and feeds the result back — until the model answers without
 * a tool call or the turn budget is spent.
 *
 * The sub-agent is strictly read-only: only non-side-effecting tools are advertised
 * or run (no write/edit/delete/run_code/run_command), and it cannot itself delegate.
 * All writing stays with the main agent, so delegation is safe to use freely. The
 * digest is length-capped so a big investigation still returns a compact result.
 */
async function runNestedAgent(
  provider: Provider,
  modelId: string,
  gate: ToolGate,
  task: string,
  signal: AbortSignal
): Promise<string> {
  const tools = availableTools(gate).filter((t) => !t.sideEffect && !SUBAGENT_EXCLUDED.has(t.name))
  const toolLines = tools.map((t) => `- ${t.name} — ${t.description} Input example: ${t.usage}`).join('\n')
  const system = [
    'You are a focused, read-only research sub-agent working inside a folder on behalf of a main agent.',
    'You are given ONE task. Investigate it with the read-only tools below, then reply with a concise findings report — facts, exact file paths, and anything the main agent needs to act. You CANNOT write files, edit, delete, or run code; do not try, and do not ask the user anything.',
    '',
    'To call a tool, write ONE fenced block and then STOP:',
    '',
    '```myto:tool',
    '{"tool": "<name>", "input": { ... }}',
    '```',
    '',
    'After the block, wait — the result comes back as a ```myto:tool_result block. Read it, then call another tool or write your final report. Keep the report tight and factual.',
    '',
    'Available tools:',
    toolLines
  ].join('\n')

  const history: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Task: ${task}` }
  ]

  for (let turn = 0; turn < NESTED_AGENT_MAX_TURNS; turn++) {
    if (signal.aborted) return 'Sub-agent cancelled.'
    let text: string
    try {
      text = await provider.getCompletion(modelId, history, undefined, signal)
    } catch (err) {
      return `Sub-agent error: ${toErrorMessage(err)}`
    }
    // Detect a tool call in the full (non-streamed) response.
    const { call } = createToolCallParser().push(text)
    if (!call) return text.trim().slice(0, NESTED_DIGEST_CAP) // no call → final report

    const toolName = call.name ?? 'tool'
    const def = call.name ? lookupTool(call.name) : undefined
    const result =
      def?.sideEffect || (call.name && SUBAGENT_EXCLUDED.has(call.name))
        ? `The "${toolName}" tool is off-limits to a read-only sub-agent. Use read/search tools only and report what you find.`
        : await runTool(call, { ...gate, signal })
    if (signal.aborted) return 'Sub-agent cancelled.'
    history.push({ role: 'assistant', content: text })
    history.push({
      role: 'user',
      content: `Tool result for ${toolName}:\n${result}\n\nContinue investigating, or give your final findings report if you have enough.`
    })
  }

  // Budget spent: ask for the report now, tools withheld.
  history.push({
    role: 'system',
    content: 'Stop using tools now. Write your final concise findings report from what you have gathered.'
  })
  try {
    const final = await provider.getCompletion(modelId, history, undefined, signal)
    return final.trim().slice(0, NESTED_DIGEST_CAP) || 'The sub-agent finished without a clear report.'
  } catch (err) {
    return `Sub-agent error: ${toErrorMessage(err)}`
  }
}

/** Resolves a request against saved settings, filling provider/model defaults. */
function resolveRequest(request: CompletionRequest): {
  provider: ReturnType<typeof providerFromSettings>
  modelId: string
  messages: ChatMessage[]
} {
  const settings = getSettings()
  const kind = request.provider ?? settings.activeProvider
  const modelId = request.modelId ?? settings.modelId
  const provider =
    kind === settings.activeProvider
      ? providerFromSettings(settings)
      : createProvider(kind, kind === 'ollama' ? settings.ollama : settings.gateway)
  return { provider, modelId, messages: request.messages }
}

/** Aborts every in-flight stream. Called on app shutdown. */
export function cancelAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
}
