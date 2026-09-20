import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  GatewayConfig,
  ListModelsResult,
  OllamaConfig,
  ProviderKind,
  ProviderSettings,
  TestConnectionResult
} from '../shared/types'
import { createProvider, providerFromSettings } from './providers'
import { toErrorMessage } from './providers/http'
import { getSettings, saveSettings } from './settings'
import {
  createStatusStripper,
  reasoningCaption,
  FILE_PROTOCOL_SYSTEM_PROMPT,
  STATUS_SYSTEM_PROMPT
} from './status'
import { runTool, toolsSystemPrompt } from './tools/registry'
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

/** Tracks in-flight streams so the renderer can cancel them by id. */
const activeStreams = new Map<string, AbortController>()

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
      }): void => {
        if (!sender.isDestroyed()) {
          sender.send(IpcChannel.ProvidersStreamChunk, { streamId, ...chunk })
        }
      }

      try {
        const { provider, modelId, messages } = resolveRequest(request)
        const settings = getSettings()
        const toolsPrompt = toolsSystemPrompt(settings)

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
            await provider.streamCompletion(modelId, turnHistory, onProviderChunk, iter.signal)
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
          { role: 'system', content: FILE_PROTOCOL_SYSTEM_PROMPT }
        ]

        // Tools off (or none available): the original single-shot behaviour, so a
        // plain-chat reply is byte-for-byte what it was before tools existed.
        if (!toolsPrompt) {
          const { error } = await runTurn([...baseSystem, ...messages], false)
          if (controller.signal.aborted) return
          send(error ? { delta: '', done: true, error } : { delta: '', done: true })
          return
        }

        // Tools on: the bounded agentic loop. History grows with each round-trip so
        // the model sees its own call and the result it got back.
        const history: ChatMessage[] = [
          ...baseSystem,
          { role: 'system', content: toolsPrompt },
          ...messages
        ]

        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
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
          const result = await runTool(call, { signal: controller.signal, settings })
          if (controller.signal.aborted) return
          send({ delta: toolResultBlock(toolName, result), done: false })

          // Record the round-trip for the model's next turn. The assistant turn is
          // its visible prose plus the call block; the tool result comes back as a
          // user turn (providers accept only user/assistant/system roles).
          const assistantTurn = (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block
          history.push({ role: 'assistant', content: assistantTurn })
          history.push({
            role: 'user',
            content: `Tool result for ${toolName}:\n${result}\n\nUse this to answer the user's request, or call another tool if you still need more. Do not repeat an identical call.`
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
