import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  ApprovalDecision,
  ApprovalRequest,
  AskQuestion,
  QuestionRequest,
  ChatImage,
  ChatMessage,
  ChatMode,
  CommandRun,
  CompletionRequest,
  CompletionResult,
  EditorEvent,
  FileChange,
  FileSnapshot,
  GatewayConfig,
  GeneratedMedia,
  ListModelsResult,
  NativeToolCall,
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
import { GatewayProvider } from './providers/gateway'
import { detectModelKind } from './providers/model-kind'
import { toErrorMessage, httpStatusOf, rateLimitRetryDelay, planFailover } from './providers/http'
import { getSettings, saveSettings } from './settings'
import {
  createStatusStripper,
  reasoningCaption,
  COWORK_SYSTEM_PROMPT,
  ALLROUNDER_SYSTEM_PROMPT,
  coworkBrowserPrompt,
  FILE_PROTOCOL_SYSTEM_PROMPT,
  IDENTITY_SYSTEM_PROMPT,
  outputStylePrompt,
  PLAN_MODE_SYSTEM_PROMPT,
  AUTO_PLAN_SYSTEM_PROMPT,
  MEDIA_EDITING_SYSTEM_PROMPT,
  credentialsSystemPrompt,
  STATUS_SYSTEM_PROMPT
} from './status'
import { availableTools, lookupTool, runTool, toolSchemas, toolsSystemPrompt, type ToolGate } from './tools/registry'
import { ensureMytoDir, readJournal, recordGoal, recordToolAction } from './cowork-memory'
import {
  looksLikeUnsavedCode,
  extractNarratedFiles,
  detectOscillation,
  looksLikeContinuationRequest,
  looksLikeAnnouncedAction,
  looksLikeFalseLimitDeferral,
  looksLikeContentFreeReply,
  researchStallVerdict,
  RESEARCH_TOOLS,
  OSCILLATION_WINDOW,
  OSCILLATION_MAX,
  MAX_AUTO_CONTINUE,
  MAX_CODE_PROSE_NUDGES,
  MAX_ANNOUNCED_ACTION,
  MAX_FALSE_LIMIT_DEFERRAL,
  MAX_EMPTY_START,
  MAX_PLAN_INCOMPLETE,
  planHasPending,
  pendingPlanTitles,
  planFileTarget,
  isVerifyStep,
  reconcilePlanProgress
} from './cowork-guards'
import { detectRuntimesCached, summarizeRuntimes } from './cowork-runtimes'
import { browserToolsEnabled } from './cowork-browser'
import { createBrowserController, type BrowserController } from './cowork-browser-runtime'
import { renderDocumentPdf } from './cowork-docgen-runtime'
import { rasterizePdf } from './document-raster-runtime'
import { runFfmpeg, probeMedia, transcribeAudio } from './ffmpeg-runtime'
import {
  listCredentialMeta,
  saveCredential,
  deleteCredential,
  resolveEnvForCommand
} from './credential-vault'
import { redactSecrets as redactSecretsCore } from './credential-vault-core'
import { capturePreviewImage } from './preview-capture-runtime'
import { runningServerUrl } from './tools/devServer'
import {
  MAX_VISUAL_REVIEWS,
  PREVIEW_ENTRY_CANDIDATES,
  pickReviewTarget,
  visualReviewInstruction,
  type ExistingEntry
} from './tools/preview-review-core'
import type { BrowserSession } from './cowork-browser-cdp'
import { readUserMemory } from './user-memory'
import { materializeAttachments, type MaterializedAttachment } from './cowork-attachments'
import { readVisionImages } from './vision-attachments'
import { insertFileSnapshot } from './db/snapshots'
import { looksLikeBigTask } from './cowork-plan-core'
import { relative } from 'node:path'
import { approvalDetail, requiresApproval } from './tools/approvals'
import { createToolCallParser, toolCallBlock, toolResultBlock, type ToolCall } from './tools/toolParser'
import { executeArgv, formatRunResult, resolveShell } from './tools/runCode'
import { resolveInWorkspace } from './tools/fs'
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

/**
 * The browser tools that act on the page (click/type). They are always confirmed
 * before they run — in Cowork via the permission tier, and in Chat (which has no
 * tier) via an explicit gate — because under `system-chrome` they drive the user's
 * own Chrome with their real logins. Read-only browser tools carry no sideEffect and
 * never prompt.
 */
const BROWSER_EXEC_TOOLS = new Set(['browser_click', 'browser_type'])

/**
 * How often, at most, to refresh the status caption from a reasoning model's
 * chain-of-thought. The model streams reasoning in tiny fragments (a real turn
 * measured ~1400 deltas over ~40s); rebuilding + sending a caption on every one
 * would spam IPC and the renderer for no visible gain. ~300ms reads as a live,
 * continuously-updating thought without the flicker.
 */
const REASONING_CAPTION_MS = 300

/**
 * Cadence for the "still receiving" heartbeat emitted while a tool-call block streams
 * in but releases no visible text yet (see {@link createToolCallParser} — the parser
 * holds the whole block until its closing fence). A big `write_file` can take minutes,
 * during which the token stream is alive (so the main-process stall guard,
 * `providers/http.ts` STREAM_STALL_MS, never fires) yet the renderer gets no delta —
 * so without this its liveness clock freezes and falsely reads "no new output … the
 * model may have stalled". A ~1s status ping (well under the renderer's 15s
 * STALL_WARN_MS) keeps the run honestly "alive" and shows the file growing live.
 */
const HELD_BLOCK_HEARTBEAT_MS = 1000

/**
 * Lightweight, opt-in structured trace for the agentic loop. One line per turn (the
 * model's stop shape — a completed tool call vs. a truncated cut-off vs. a plain end —
 * plus the live plan state and reply length) and one per finish (WHY the loop ended:
 * natural completion, verify pass, a cap hit, an error, the turn budget). This is the
 * "add logging: stop_reason, tool calls, plan state, reason for finishing" the fix
 * brief asks for, so a run that stops early can be diagnosed after the fact. OFF unless
 * `MYTO_AGENT_LOG` is set (e2e / debugging) so production stays quiet, and it logs only
 * structural counters and tool NAMES — never message content, file contents, or the API
 * key — so enabling it can't leak secrets.
 */
function agentTrace(event: string, data: Record<string, unknown>): void {
  if (!process.env.MYTO_AGENT_LOG) return
  try {
    // eslint-disable-next-line no-console
    console.log(`[myto:agent] ${event} ${JSON.stringify(data)}`)
  } catch {
    // eslint-disable-next-line no-console
    console.log(`[myto:agent] ${event}`)
  }
}

/**
 * A short present-tense label for a tool whose call block is still streaming in, used
 * only by the held-block heartbeat (see {@link HELD_BLOCK_HEARTBEAT_MS}) while the
 * block is buffered and no card exists yet. Falls back to a generic "Receiving the
 * response" when the tool name has not streamed in or is unknown.
 */
function streamingToolLabel(name: string | null): string {
  switch (name) {
    case 'write_file':
      return 'Writing the file'
    case 'edit_file':
      return 'Editing the file'
    case 'create_document':
      return 'Creating the document'
    case 'run_command':
    case 'run_code':
      return 'Preparing the command'
    case 'update_plan':
      return 'Updating the plan'
    default:
      return 'Receiving the response'
  }
}

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
 * dozens of round-trips, so this is generous; but it is NO longer unbounded. An
 * unbounded loop was the "task runs for 10 hours" failure: a weak model on a slow
 * endpoint could grind through hundreds of single-call generations, and every
 * stall-guard nudge each added another. Three bounds now work together: this turn
 * cap, the wall-clock budget ({@link COWORK_TIME_BUDGET_MS}), and the stall guards
 * ({@link MAX_REPEAT_CALLS} / {@link MAX_EXPLORE_WITHOUT_BUILD} /
 * {@link detectOscillation} / {@link researchStallVerdict}). When either budget
 * ends the loop, the closing turn still withholds tools so the reply never ends
 * mid-loop, and the user can always Stop sooner.
 */
const MAX_TOOL_TURNS_COWORK = 120

/**
 * Wall-clock budget for one agentic reply, independent of the turn cap. A slow
 * endpoint makes per-turn time the real cost driver (a generation can legally
 * run ten minutes), so time — not turn count — is what bounds a marathon run.
 * When the budget is spent the loop exits through the same closing turn as the
 * turn cap: tools withheld, answer-with-what-you-have.
 */
const COWORK_TIME_BUDGET_MS = 45 * 60_000

/**
 * When the running message history (system prompts + the growing tool round-trips)
 * exceeds roughly this many characters, the older middle of it is compacted into a
 * short summary before the next turn — see {@link compactHistory}. Two ceilings,
 * chosen per provider: a large one for remote BYOK endpoints (~90k tokens, inside a
 * modern 128k+ window with room to generate) and the old small one for local Ollama
 * models, whose context windows are often just 8–32k. Compacting too early was the
 * single biggest "the agent searches the same files over and over" cause: the model's
 * gathered findings (file contents, learned paths, failed attempts) were folded away
 * every few turns, forcing it to re-explore from scratch — each re-exploration another
 * slow generation. The remote ceiling makes the working memory last a whole task.
 */
const COMPACT_OVER_CHARS_LOCAL = 90_000
const COMPACT_OVER_CHARS_REMOTE = 360_000

/**
 * How many of the most recent messages to keep verbatim when compacting. The last
 * round-trips are what the model is actively reasoning over, so they must stay
 * intact; everything older is what gets folded into the summary. Twelve messages ≈
 * six full round-trips — enough working set that the model rarely needs to re-read
 * what it just saw.
 */
const COMPACT_KEEP_RECENT = 12

/**
 * Stall guard: if the model issues this many IDENTICAL consecutive tool calls (same
 * name + input), the loop stops early rather than burning the whole budget spinning
 * on a call that isn't advancing the task. It is fed a nudge before the final count.
 */
const MAX_REPEAT_CALLS = 3

/**
 * Programmatic verify gate (#16). When the user set `cowork.verifyCommand` (a build/
 * test/lint line), the loop refuses to call a Cowork run "done" until that command
 * exits 0: a non-zero exit is fed back as a user turn so the model can fix it and the
 * command runs again. Bounded so a persistently failing command can't loop forever —
 * after this many rounds the run ends anyway with the last failure on record.
 */
const MAX_VERIFY_ROUNDS = 3
/** How long a single verify command may run before it is killed (builds/tests are slow). */
const VERIFY_TIMEOUT_MS = 180_000

/**
 * How many times, within a SINGLE reply, the agentic loop will automatically resume a
 * tool call the model cut off mid-stream. When a big `write_file` runs into the model's
 * output-token limit before its closing fence, the partial call is dropped and nothing
 * runs — the classic "built one file, then Stopped mid-project" halt users hit. Instead
 * of ending the run with a dead "Send continue" notice, the loop re-asks the model to
 * re-issue the interrupted call in full, telling it to split a very large file across
 * write_file + edit_file so it stops re-truncating at the same point, then loops on with
 * tools still live. The counter tracks CONSECUTIVE truncations with no completed tool
 * call in between (any real tool call resets it), so a genuinely large project that
 * truncates a few times keeps going, while a file that truncates forever can't spin
 * endlessly — after the cap the run surfaces the honest notice and stops.
 */
const MAX_TRUNCATION_CONTINUES = 6

/**
 * Most tool calls the loop will execute from a SINGLE text-protocol generation (RC-7).
 * Weak models routinely batch several ```myto:tool blocks in one reply — e.g. three
 * write_file calls then the update_plan that marks them done. The old loop ran only the
 * FIRST and discarded the rest (it aborted the generation the moment one call parsed), so
 * the batched update_plan never ran and the plan stayed frozen at 0/N (the plan-stays-0/4
 * bug). We now collect the whole batch and execute it across successive turns. The cap is a
 * runaway guard, not an expected ceiling: a well-behaved reply carries a handful of calls.
 */
const MAX_BATCH_CALLS = 16

/** Read-only "look at the project" tools — churning on these without building is the
 *  classic weak-model stall (see the progress guard in the Cowork loop). */
const EXPLORE_TOOLS = new Set(['list_dir', 'read_file', 'search_code', 'find_files'])
/** After this many explorations with nothing built yet, force a "stop looking, build
 *  now". Generous (it was 2, which punished the legitimate orientation pass a real
 *  codebase needs — 8 read/list calls is normal investigation, and the hard directive
 *  fired mid-research, pressuring half-informed builds) while still catching a
 *  read-only spin that never produces anything. */
const MAX_EXPLORE_WITHOUT_BUILD = 8

/**
 * How many times in a row the model may call the `think` tool (pure deliberation, no
 * action) before the loop steps in. Thinking between actions is exactly the behaviour we
 * want — this only guards the degenerate case of a model that thinks over and over without
 * ever acting. On reaching the cap it gets one hard "stop thinking, act now" nudge; a think
 * PAST the cap ends the loop and forces a closing answer. Reset whenever any other (real)
 * tool runs, so interleaved think→act→think→act never trips it. See the `think` tool.
 */
const MAX_THINK_STREAK = 4

/** Parse the `think` tool's `{thought: string}` input into the reasoning text to surface. */
function thinkText(input: unknown): string {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const raw = rec.thought ?? rec.thinking ?? rec.text
  return typeof raw === 'string' ? raw.trim() : ''
}

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

/** The session-compaction ceiling for local Ollama models, whose windows are often 8–32k. */
const SESSION_COMPACT_OVER_TOKENS_LOCAL = 24_000

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
        command?: CommandRun
        fileChange?: FileChange
        thinking?: string
        thinkingReset?: boolean
        media?: GeneratedMedia[]
        editor?: EditorEvent
      }): void => {
        if (!sender.isDestroyed()) {
          sender.send(IpcChannel.ProvidersStreamChunk, { streamId, ...chunk })
        }
      }

      /**
       * The most recent preview the model raised this run (via `preview`/`run_dev_server`),
       * captured so the build-complete visual review can screenshot exactly what it last showed —
       * see {@link pickReviewTarget}. Null until the model previews something.
       */
      let lastPreview: PreviewTarget | null = null

      /** Forward a preview the `preview` tool raised to the renderer's pane (Cowork). */
      const onPreview = (target: PreviewTarget): void => {
        lastPreview = target
        send({ delta: '', done: false, preview: target })
      }

      /**
       * The latest working plan the model published via `update_plan`, captured so the
       * loop can gate its finish on it (RC-1): a no-tool-call turn with items still not
       * done should nudge the model onward, not be read as a completed run. Display-only
       * forwarding alone ({@link onPlan}) left this state invisible to the loop.
       */
      let latestPlan: TodoItem[] = []

      /** Forward the working plan the `update_plan` tool published (Cowork). */
      const onPlan = (todos: TodoItem[]): void => {
        latestPlan = todos
        send({ delta: '', done: false, todos })
      }

      /** Forward a command the `run_command` tool ran to the renderer's Terminal pane (Cowork). */
      const onCommand = (run: CommandRun): void => {
        send({ delta: '', done: false, command: run })
      }

      /**
       * Persist a before/after capture from a Cowork mutation tool (#1 checkpoints /
       * rewind). Keyed by the session + the user message this run answers + a per-run
       * id, so a later "restore to here" can replay the run's file changes in reverse.
       * Only persists when the caller supplied a sessionId (Cowork); best-effort — a DB
       * fault must never break the live reply, so it is swallowed.
       */
      const snapRunId = `run-${streamId}`
      /**
       * The working folder, captured once it is computed below (it lives in a deeper
       * block than this callback), so {@link onFileSnapshot} can report each change to
       * the live Working-tree pane as a workspace-RELATIVE path rather than an absolute
       * one. Null leaves the path as-is.
       */
      let fileChangeRoot: string | null = null
      /** Whole-version line count (null/'' → 0), matching FileCard's +added/−removed convention. */
      const lineCount = (s: string | null | undefined): number => (s ? s.split('\n').length : 0)
      const onFileSnapshot = (snapshot: FileSnapshot): void => {
        if (!request.sessionId) return
        try {
          insertFileSnapshot({
            ...snapshot,
            sessionId: request.sessionId,
            afterMsgId: request.afterMsgId ?? null,
            runId: snapRunId,
            createdAt: Date.now()
          })
        } catch {
          // A snapshot only powers rewind; never let a DB hiccup break the run.
        }
        // ALSO forward the change to the renderer's live Working-tree pane (Feature 2):
        // a workspace-relative, forward-slashed path plus whole-version line counts. The
        // store upserts by path, so a file touched repeatedly shows once with its latest
        // counts. Display-only — a failure here must never break the run.
        try {
          const rel = fileChangeRoot ? relative(fileChangeRoot, snapshot.path) : snapshot.path
          const relPosix = rel.split(/[/\\]+/).filter(Boolean).join('/') || snapshot.path
          send({
            delta: '',
            done: false,
            fileChange: {
              path: relPosix,
              kind: snapshot.kind,
              added: lineCount(snapshot.after),
              removed: lineCount(snapshot.before)
            }
          })
        } catch {
          // Live-tree forwarding is cosmetic; swallow and carry on.
        }
      }

      /**
       * Raise an approval prompt for a side-effecting Cowork tool and wait for the
       * user's answer. Resolves to their decision, or 'deny' if the stream is
       * cancelled while waiting so a Stop never leaves the loop parked forever.
       */
      const requestApproval = (
        toolName: string,
        sideEffect: ToolSideEffect,
        detail: string,
        plan = false
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
          send({
            delta: '',
            done: false,
            approval: { approvalId, toolName, sideEffect, detail, ...(plan ? { plan: true } : {}) }
          })
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

      // Track 2 browser (Track 2): declared out here — before the try — so the `finally`
      // can dispose it. It is assigned lazily inside the run by the `getBrowser` memo when
      // the first browser_* tool call opens the chosen target, and stays null when the
      // browser is never used.
      let browserController: BrowserController | null = null

      try {
        const { provider, modelId, messages, kind } = resolveRequest(request)
        const settings = getSettings()
        const mode: ChatMode = request.mode ?? 'chat'
        // Local Ollama models run with much smaller context windows (often 8–32k) than
        // remote BYOK endpoints (128k+), so every size budget below picks its ceiling
        // by provider kind — the remote ceilings would silently overflow a local model.
        const isLocalOllama = kind === 'ollama'
        // Adaptive reasoning effort: the user's setting, capped at 'low' for trivial
        // prompts (a greeting must not wait through a reasoning model's full
        // chain-of-thought — see isTrivialPrompt).
        const latestUserMessage = [...messages].reverse().find((m) => m.role === 'user')
        const effortForRun: ProviderSettings['reasoningEffort'] = isTrivialPrompt(
          latestUserMessage?.content ?? ''
        )
          ? 'low'
          : settings.reasoningEffort

        // Feature B — media generation. When the active model is an image/video model
        // (auto-detected from its id; an explicit settings.modelKind overrides), this turn
        // produces a picture/clip, not text — so it never reaches the chat/tool loop below.
        // We fulfil the prompt against the user's OWN configured gateway (the capability they
        // asked for — no third-party call), stream the result back as inline media, and end
        // the turn. Every ordinary chat model classifies as 'chat' here, so nothing changes
        // for them. Ollama can't generate media, so we say so plainly.
        const modelKind = detectModelKind(modelId, settings.modelKind)
        if (modelKind !== 'chat') {
          let prompt = ''
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
              prompt = messages[i].content.trim()
              break
            }
          }
          if (!(provider instanceof GatewayProvider)) {
            send({
              delta:
                'Image/video generation needs a gateway (BYOK) endpoint — the local Ollama provider can only generate text. Add an image or video model on the Myto website → Authentication page and select it here.',
              done: false
            })
            send({ delta: '', done: true })
            return
          }
          if (!prompt) {
            send({ delta: `Type a prompt describing the ${modelKind} you want, then send.`, done: false })
            send({ delta: '', done: true })
            return
          }
          send({ delta: '', done: false, status: modelKind === 'video' ? 'Generating video…' : 'Generating image…' })
          try {
            const media =
              modelKind === 'video'
                ? await provider.generateVideo(modelId, prompt, {}, controller.signal)
                : await provider.generateImages(modelId, prompt, {}, controller.signal)
            if (controller.signal.aborted) return
            send({ delta: '', done: false, status: '' })
            if (media.length === 0) {
              send({
                delta: `The model returned no ${modelKind}. This endpoint may not support ${modelKind} generation (it exposes an OpenAI-style \`/${modelKind === 'video' ? 'videos' : 'images'}/generations\` route), or the prompt was declined.`,
                done: false
              })
              send({ delta: '', done: true })
              return
            }
            send({ delta: '', done: false, media })
            send({ delta: '', done: true })
          } catch (err) {
            if (controller.signal.aborted) return
            send({ delta: `Couldn't generate the ${modelKind}: ${toErrorMessage(err)}`, done: false })
            send({ delta: '', done: true })
          }
          return
        }

        // Session-level auto-compaction: a very long thread (loaded whole from the DB)
        // can crowd even a large context window. Before running the turn, if the
        // conversation is over the token ceiling, fold its older turns into one summary
        // so both plain chat and Cowork keep answering. Transient — the DB keeps the full
        // transcript; only what the model sees this turn is compacted. A brief status
        // caption surfaces it while the summarizer call runs.
        let convo = messages
        if (estimateTokens(convo) > (isLocalOllama ? SESSION_COMPACT_OVER_TOKENS_LOCAL : SESSION_COMPACT_OVER_TOKENS)) {
          send({ delta: '', done: false, status: 'Compacting earlier conversation to fit context…' })
          convo = await compactConversation(convo, provider, modelId, controller.signal)
          if (controller.signal.aborted) return
          send({ delta: '', done: false, status: '' })
        }
        // Vision input: this turn's IMAGE attachments reach the active model inline, in
        // EVERY mode — attaching an image means "look at this". Populate images on the
        // latest user turn; the adapters expand it into the provider's native image block.
        // Best-effort — oversized/unreadable images are skipped (still reachable as files
        // in Cowork via materializeAttachments below), and a failure never blocks the reply.
        if (request.sessionId) {
          const visionImages = await readVisionImages(request.sessionId, request.afterMsgId ?? null)
          if (controller.signal.aborted) return
          if (visionImages.length > 0) {
            for (let i = convo.length - 1; i >= 0; i--) {
              if (convo[i].role === 'user') {
                convo[i] = { ...convo[i], images: [...(convo[i].images ?? []), ...visionImages] }
                break
              }
            }
          }
        }
        // Mode shape. Research and Cowork are the two "agentic" modes (full tool loop,
        // unbounded budget, compaction). Research is the folderless, agent-driven surface:
        // it roots the filesystem tools at the user's home directory and arms the browser
        // by default, so the chosen specialist can reach anywhere and drive the web without
        // the user picking a folder or flipping a setting — side-effects still gated below.
        const research = mode === 'research'
        const agentic = mode === 'cowork' || research
        // In Cowork, the filesystem tools are scoped to this folder; null when none
        // is set, which keeps those tools dormant (see tools/fs.ts + registry.ts).
        // Folder selection is MANDATORY and enforced in the composer: a Cowork message
        // can't be sent until the user picks a working folder (ChatPanel gates send on
        // it, opening the native picker when missing). So by the time a Cowork run
        // reaches here the folder is already set and persisted — we simply read it, and
        // never prompt for a name mid-run (that old per-message "name the folder?" ask
        // is gone). A still-empty workspaceDir just leaves the fs tools dormant.
        const workspaceDir = research ? homedir() : settings.cowork.workspaceDir.trim() || null
        // Hand the working folder to onFileSnapshot (declared above, in an outer block) so
        // live file-change chunks carry workspace-relative paths for the Working-tree pane.
        fileChangeRoot = workspaceDir
        // Research arms the full agent runtime by default (the mandate: every one of the
        // 300+ specialists drives the browser and reaches the user's files without any
        // opt-in dance). We synthesise an "effective settings" whose cowork.workspaceDir is
        // the home root and whose browserTarget is coerced off→in-app, and drive the gate,
        // tool advertisement, and browser launch off it. Cowork is untouched (effSettings ===
        // settings by value there). Side-effects stay behind the same permission tier, and
        // the fs sandbox (resolveInWorkspace) still confines every path under the home root.
        const effSettings: ProviderSettings = research
          ? {
              ...settings,
              cowork: {
                ...settings.cowork,
                workspaceDir: workspaceDir ?? '',
                browserTarget:
                  settings.cowork.browserTarget === 'off' ? 'in-app' : settings.cowork.browserTarget
              }
            }
          : settings
        const gate: ToolGate = { settings: effSettings, mode, workspaceDir }
        const toolsPrompt = toolsSystemPrompt(gate)
        // Native function-calling (#15): opt-in AND the endpoint's wire format must support
        // it. When on, we advertise structured tool schemas and read the model's structured
        // tool call instead of the ```myto:tool text protocol; when off (the default) or the
        // backend can't carry it, nothing changes. Only meaningful when tools exist at all.
        const useNativeTools =
          !!toolsPrompt && settings.nativeTools && (provider.supportsNativeTools?.() ?? false)
        const nativeSchemas = useNativeTools ? toolSchemas(gate) : []
        // Cowork and Research are the agentic modes: unbounded tool budget, filesystem +
        // agent tools, in-loop compaction. Plain Chat keeps the short bounded loop.
        const maxToolTurns = agentic ? MAX_TOOL_TURNS_COWORK : MAX_TOOL_TURNS

        // The current task, used to surface the most RELEVANT older memory notes
        // (offline, deterministic) when a long journal/global memory overflows its cap.
        // Omitted-query path is byte-identical to the old recency tail, so this only
        // ever helps. Chat and Cowork both pass it.
        const recallQuery = ([...convo].reverse().find((m) => m.role === 'user')?.content ?? '').trim()

        // Cowork project memory (.myto/journal.md): read what earlier turns already
        // did in this folder so this turn continues instead of repeating. Best-effort.
        let coworkMemory = ''
        if (mode === 'cowork' && workspaceDir) {
          ensureMytoDir(workspaceDir)
          coworkMemory = readJournal(workspaceDir, recallQuery)
        }
        // Runtime awareness (Track 1): hand the agent the interpreters/toolchains that
        // are actually installed and the EXACT command to invoke each, up front, so a
        // weaker model scripts deliverables with a real command instead of guessing
        // `python3` on Windows (the Store alias). Cached per process (runtimes are
        // stable within a session); best-effort — probing never blocks the reply.
        let runtimeSummary = ''
        if (agentic && workspaceDir && settings.tools.enabled) {
          try {
            runtimeSummary = summarizeRuntimes(await detectRuntimesCached(controller.signal))
          } catch {
            // Probe failed or was cancelled — proceed without the readout.
          }
          if (controller.signal.aborted) return
        }
        // Saved-credential awareness (vault): the names/scopes/usage of secrets saved for
        // this folder, so the agent knows it can run `git push` etc. without asking the
        // user to paste a token. Values are NEVER included (there is no path to read one
        // back). Computed once here; '' when none, which omits the system turn below.
        const credentialsPrompt =
          agentic && workspaceDir ? credentialsSystemPrompt(listCredentialMeta(workspaceDir)) : ''
        // Global (user-level) memory: cross-project facts/preferences the user saved,
        // injected in EVERY mode (chat and cowork) so they always apply. Best-effort.
        const userMemory = readUserMemory(recallQuery)
        // Attachments → working folder: the user's uploaded files live under
        // userData/attachments/… which the sandboxed fs tools (and edit_photo/edit_video)
        // can't reach. Copy THIS turn's into <workspace>/uploads/ so the agent opens them
        // directly by path instead of hunting the disk, and note them in the system head
        // below. Runs in BOTH agentic modes — Build (cowork, chosen folder) AND Cowork
        // (research, home root) — so "edit this photo" on an attachment works in either.
        // Best-effort; never blocks the reply.
        let attachedFiles: MaterializedAttachment[] = []
        if (agentic && workspaceDir && request.sessionId) {
          attachedFiles = await materializeAttachments(
            request.sessionId,
            request.afterMsgId ?? null,
            workspaceDir
          )
          if (controller.signal.aborted) return
        }
        // Permission tier for side-effecting tools; consulted in the agentic modes
        // (Cowork and Research). Research inherits the same cowork.permissionMode tier.
        const permissionMode = settings.cowork.permissionMode
        // Output style (#13): the persisted global voice preference, resolved to its
        // system instruction once ('' for 'default') and injected into baseSystem below.
        const outputStyleInstruction = outputStylePrompt(settings.outputStyle)
        // Plan mode (#8): a Cowork-only gate. When on, the agent must research, present a
        // plan with present_plan, and win the user's approval before the first write/exec
        // tool. Injects the plan directive into baseSystem and arms the plan gate in the
        // loop below. TWO triggers: the explicit Plan-mode toggle, OR — toggle off — an
        // auto-detected substantial build (looksLikeBigTask), so a big ask ("build a
        // portfolio site") still gets a plan-first pass while small edits proceed directly.
        const latestUserText = ([...convo].reverse().find((m) => m.role === 'user')?.content ?? '').trim()
        const autoPlan =
          mode === 'cowork' && !settings.cowork.planMode && !!workspaceDir && looksLikeBigTask(latestUserText)
        const planActive = (mode === 'cowork' && settings.cowork.planMode) || autoPlan

        // The all-rounder ("Cowork" in the UI, internally `research`) announces itself so
        // the user sees the mode on the status line while it spins up. Its persona is a
        // single fixed all-rounder prompt (ALLROUNDER_SYSTEM_PROMPT) — there is no per-run
        // agent picker any more, so nothing to resolve here.
        if (research) {
          send({ delta: '', done: false, status: 'Cowork · all-rounder' })
        }

        /**
         * Run a focused read-only sub-task in a nested agent (the `spawn_agent` tool).
         * Bound to this run's provider/model/gate and cancel signal. Returns a digest;
         * the sub-agent shares nothing with the visible stream, so it never touches the
         * UI or the main history except through the string it returns.
         */
        const delegate = (task: string): Promise<string> =>
          runNestedAgent(provider, modelId, gate, task, controller.signal)

        /**
         * Browser session for this run (Track 2), created lazily and memoized: the first
         * `browser_*` tool call opens the chosen target (the in-app sandboxed window or the
         * user's system Chrome) and later calls reuse it; it is disposed in the `finally`
         * below. Left undefined unless a browser target other than off is armed — which
         * is exactly when the browser tools are advertised (in Chat AND Cowork) — so a
         * defined `getBrowser` and an available browser tool always coincide. A failed
         * launch keeps its rejected promise, so the tool reports the reason instead of
         * relaunching on every call. (`browserController` itself is declared above the try
         * so the `finally` can dispose it.)
         */
        let browserPending: Promise<BrowserSession> | null = null
        const getBrowser =
          browserToolsEnabled(effSettings.cowork.browserTarget)
            ? (): Promise<BrowserSession> => {
                if (!browserPending) {
                  browserPending = createBrowserController(
                    effSettings.cowork.browserTarget,
                    controller.signal
                  ).then((ctrl) => {
                    browserController = ctrl
                    return ctrl.session
                  })
                }
                return browserPending
              }
            : undefined

        /**
         * Render a finished HTML page to PDF bytes for the `create_document` tool — backed by
         * Chromium's own `webContents.printToPDF` in a hidden window (cowork-docgen-runtime.ts),
         * the one PDF engine the app already ships. Always wired (Electron is always present in
         * the running app), so `create_document` can emit real PDFs; only in unit tests — where
         * this ctx field is absent — does the tool fall back to writing HTML.
         */
        const renderDocument = (
          html: string,
          kind: import('./cowork-docgen').DocKind
        ): Promise<Uint8Array> => renderDocumentPdf(html, kind)

        /**
         * A2b — images a tool produced this round (a scanned PDF page `render_document`
         * rasterized to a picture the model can read). They must ride on the SAME
         * tool-result USER turn we push after the call, never a fresh consecutive user
         * turn: providers require strict user/assistant alternation, and two user turns in
         * a row is an HTTP 400. So the tool doesn't return images inline — it calls this to
         * park them, and the loop drains {@link pendingToolImages} onto the tool-result turn
         * (and mirrors them to the renderer as a `media` chunk so the user sees the pages).
         */
        let pendingToolImages: ChatImage[] = []
        let pendingToolImageCaption: string | undefined
        const emitToolImages = (images: ChatImage[], caption?: string): void => {
          if (!images.length) return
          pendingToolImages = pendingToolImages.concat(images)
          if (caption && !pendingToolImageCaption) pendingToolImageCaption = caption
        }

        /**
         * Rasterize a scanned PDF's pages to PNG data-URLs for the `render_document` tool —
         * backed by pdf.js on a hidden Chromium canvas (document-raster-runtime.ts). Always
         * wired in the running app (Electron is present), so the tool can turn a text-less PDF
         * into images the vision model reads; only in unit tests — where this ctx field is
         * absent — does the tool fall back to a "needs the app runtime" note.
         */
        const rasterizeDocument = (
          bytes: Uint8Array,
          pages: unknown,
          scale: unknown,
          signal?: AbortSignal
        ): Promise<{ total: number; pages: number[]; dataUrls: string[] }> =>
          rasterizePdf(bytes, pages, scale, signal)

        /**
         * The video/photo editing tools' native half (tools/media-edit.ts). All pure arg
         * building + edit-plan validation lives in tools/ffmpeg-core.ts; these just surface
         * progress and finished output to the renderer. `onStatus` pushes a human caption
         * ("Rendering 42% (3.1x)") to the rolling status line, exactly like a <status> tag;
         * `emitMedia` shows an edited video/image inline as a `media` chunk — sent straight to
         * the renderer, not parked like vision stills, since it's for the user to watch, never
         * model input. The spawn wrappers (`runFfmpeg`/`probeMedia`/`transcribeAudio`) are the
         * bundled-binary half (ffmpeg-runtime.ts); only in unit tests, where these ctx fields
         * are absent, do the media tools degrade to a "needs the app runtime" note.
         */
        const onStatus = (status: string): void => {
          if (status.trim()) send({ delta: '', done: false, status })
        }
        const emitMedia = (media: GeneratedMedia[]): void => {
          if (media.length) send({ delta: '', done: false, media })
        }
        /**
         * Drive the live Editor pane (Build "watch Myto edit"). The edit_photo/edit_video tools
         * push open → script → progress → baked through this; each rides out-of-band on its own
         * chunk (empty delta) exactly like {@link emitMedia}, and never blocks the loop.
         */
        const onEditorEvent = (editor: EditorEvent): void => {
          send({ delta: '', done: false, editor })
        }

        /**
         * Per-run credential bridge (vault). Two closures sharing ONE accumulating set of the
         * secret values actually injected so far this run — the least-exposure principle: only
         * a value that was really placed into some command's env could appear in that command's
         * output, so that set is exactly what the redactor must mask. The set only grows (never
         * reset mid-run) and nothing is added unless {@link resolveCredentialEnv} truly injected
         * it, so a just-saved-but-never-used secret is never put at risk of surfacing.
         *
         * `resolveCredentialEnv` is handed to the exec tools (run_command/git/git_publish): it
         * returns the scoped env for a command and records the values it injected. `redactSecrets`
         * is the single scrubber the registry runs over EVERY tool's model-facing return, and the
         * exec tools additionally run it over their Terminal-pane mirror (a separate channel).
         */
        const injectedSecrets = new Set<string>()
        const resolveCredentialEnv = (command: string): NodeJS.ProcessEnv | undefined => {
          if (!workspaceDir) return undefined
          const env = resolveEnvForCommand(workspaceDir, command)
          if (env) {
            for (const v of Object.values(env)) {
              // Short, word-like values aren't real secrets and masking them would blank out
              // ordinary output; redactSecretsCore skips <4 too, so this just keeps the set tidy.
              if (typeof v === 'string' && v.length >= 4) injectedSecrets.add(v)
            }
          }
          return env
        }
        const redactSecrets = (text: string): string => redactSecretsCore(text, injectedSecrets)

        /**
         * User-configured lifecycle hooks (#9). PreToolUse runs a shell command BEFORE
         * each tool; a non-zero exit VETOES the call — its output is fed back to the model
         * as the tool result, exactly like a permission denial. PostToolUse runs AFTER and
         * is observational — its output is surfaced as a status line, never merged into the
         * result. Both are the user's OWN commands (Settings › Cowork › Hooks), so this is
         * an arbitrary-exec surface: it is gated to Cowork, runs inside the working folder,
         * is bounded by a timeout, and passes the tool name/input/result as env vars. A
         * missing or blank command is a no-op (the closure is left undefined).
         */
        const HOOK_TIMEOUT_MS = 30_000
        const runHook = async (
          command: string,
          call: ToolCall,
          resultText: string | null
        ): Promise<{ exitCode: number | null; output: string }> => {
          const spec = resolveShell()
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            MYTO_TOOL_NAME: call.name ?? '',
            MYTO_TOOL_INPUT: JSON.stringify(call.input ?? null),
            ...(resultText != null ? { MYTO_TOOL_RESULT: resultText } : {})
          }
          const r = await executeArgv(spec.cmd, [spec.flag, command], controller.signal, {
            cwd: workspaceDir ?? undefined,
            env,
            timeoutMs: HOOK_TIMEOUT_MS
          })
          const output =
            [r.stdout, r.stderr].map((s) => s.trimEnd()).filter(Boolean).join('\n') || (r.spawnError ?? '')
          return { exitCode: r.spawnError ? null : r.exitCode, output }
        }

        const preHookCmd = mode === 'cowork' ? settings.cowork.hooks.preToolUse.trim() : ''
        const preToolUse = preHookCmd
          ? async (call: ToolCall): Promise<{ block?: string } | void> => {
              send({ delta: '', done: false, status: 'Running pre-tool hook' })
              const { exitCode, output } = await runHook(preHookCmd, call, null)
              if (exitCode !== 0) {
                return {
                  block: `A PreToolUse hook blocked "${call.name ?? 'tool'}" (exit ${exitCode ?? 'n/a'}).${
                    output ? `\n${output}` : ''
                  }\nDo not retry it; continue without it or tell the user what you need to proceed.`
                }
              }
              return
            }
          : undefined

        const postHookCmd = mode === 'cowork' ? settings.cowork.hooks.postToolUse.trim() : ''
        const postToolUse = postHookCmd
          ? async (call: ToolCall, result: string): Promise<void> => {
              const { output } = await runHook(postHookCmd, call, result)
              if (output) send({ delta: '', done: false, status: `Post-tool hook: ${output.slice(0, 200)}` })
            }
          : undefined

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
        ): Promise<{ visible: string; call: ToolCall | null; calls?: ToolCall[]; error?: string; truncated?: boolean }> => {
          // Per-turn abort, chained to the outer user-cancel controller: aborting
          // `iter` ends just this generation (e.g. once a tool call is complete)
          // without tearing down the whole reply.
          const iter = new AbortController()
          const onOuterAbort = (): void => iter.abort()
          if (controller.signal.aborted) iter.abort()
          else controller.signal.addEventListener('abort', onOuterAbort, { once: true })

          const stripper = createStatusStripper()
          // The text-protocol fence parser is ALWAYS on when tools are live — even in
          // native mode. Native function-calling reads a STRUCTURED tool call off a
          // disjoint channel (chunk.toolCall), but a model on a native-capable endpoint
          // routinely DRIFTS to emitting the ```myto:tool TEXT protocol instead: the loop
          // records every tool RESULT as a ```myto:tool_result text block, so the model
          // sees that shape in history and imitates it. With the parser off (the old
          // `!useNativeTools` gate) those text calls leaked into the reply as prose, ran
          // NOTHING, and read as the model stopping mid-build — the plan-stalls-at-N/M
          // halt this whole investigation chased (RC-9). Running both channels at once is
          // safe: a native call arrives as structured args (never in the text stream) and
          // a text call arrives as prose (never as chunk.toolCall), so they never double-
          // fire, and real prose almost never contains the exact fence. See NOTES.md RC-9.
          const toolParser = parseTools ? createToolCallParser() : null
          let reasoningText = ''
          let contentStarted = false
          let captionFromReasoning = false
          let lastReasoningEmit = 0
          // Throttle + running size for the held-tool-block heartbeat (see
          // {@link HELD_BLOCK_HEARTBEAT_MS}). `heldToolChars` is the approximate number
          // of characters streamed into the currently-open block; both reset the moment
          // no block is being held.
          let lastHeldEmit = 0
          let heldToolChars = 0
          // Whether this turn's thinking phase has already been closed (a fresh
          // <status>-derived caption is transient, but the raw chain-of-thought is a
          // discrete block that must be closed exactly once — see closeThinking).
          let thinkingClosed = false
          let visible = ''
          let pendingCall: ToolCall | null = null
          // Additional complete tool calls the model batched AFTER the first in this one
          // generation (RC-7). The text protocol lets a reply carry several ```myto:tool
          // blocks; we collect every one here and hand them all back so the loop runs the
          // whole batch (the first as this turn's call, the rest on following turns) instead
          // of discarding all but the first — which is why a batched update_plan-done never
          // landed and the plan stayed at 0/N.
          const extraCalls: ToolCall[] = []
          // Set when the provider reports the model stopped at its OUTPUT-token limit
          // (terminal chunk `truncated`), or when a native tool call's JSON arguments
          // arrive unparseable — both mean "the reply was cut off mid-answer." The loop
          // reads the returned `truncated` to auto-resume instead of treating the partial
          // output as a finished turn (RC-2).
          let sawTruncation = false

          // Close this turn's thinking phase (if one is open): send a final snapshot
          // then a reset so the renderer's block stops blinking and the NEXT turn's
          // reasoning opens a fresh block instead of overwriting this one. Idempotent.
          const closeThinking = (): void => {
            if (!reasoningText || thinkingClosed) return
            thinkingClosed = true
            send({ delta: '', done: false, thinking: reasoningText })
            send({ delta: '', done: false, thinkingReset: true })
          }

          // Route status-stripped text through the tool parser (when on): forward the
          // prose it releases and collect every complete tool call in this generation.
          // Unlike the old path (which aborted on the FIRST call), we keep parsing so a
          // reply that batches several ```myto:tool blocks runs them ALL (RC-7). With tools
          // off it is a straight passthrough.
          const emitText = (piece: string): void => {
            if (!piece) return
            if (toolParser) {
              // Drain loop: one push can release prose AND complete a call, and a single
              // delta can even carry two whole blocks (the parser buffers the second and
              // yields it on the next push, so we re-push empty to pull it out). Feed the
              // real `piece` once, then '' to flush any further buffered call.
              for (let first = true; ; first = false) {
                const { text, call } = toolParser.push(first ? piece : '')
                if (text) {
                  visible += text
                  send({ delta: text, done: false })
                }
                if (!call) break
                if (!pendingCall) pendingCall = call
                else if (extraCalls.length < MAX_BATCH_CALLS - 1) extraCalls.push(call)
                else {
                  // Runaway batch — stop generating rather than collect without bound.
                  iter.abort()
                  return
                }
              }
              // A tool block is streaming in but the parser releases no visible text
              // until its closing fence — a large write_file can stream for minutes.
              // The token stream is alive (the stall guard stays armed, so no
              // StallError), yet the renderer sees no delta, so its liveness clock
              // would freeze and falsely warn "no new output … may have stalled". Emit
              // a throttled heartbeat: it re-stamps the run's activity and shows the
              // file growing live. Reset the counters whenever nothing is held.
              if (toolParser.holdingBlock) {
                heldToolChars += piece.length
                const now = Date.now()
                if (now - lastHeldEmit >= HELD_BLOCK_HEARTBEAT_MS) {
                  lastHeldEmit = now
                  const label = streamingToolLabel(toolParser.holdingToolName)
                  send({ delta: '', done: false, status: `${label}… (${heldToolChars.toLocaleString()} chars)` })
                }
              } else {
                heldToolChars = 0
                lastHeldEmit = 0
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
            toolCall?: NativeToolCall
            truncated?: boolean
          }): void => {
            // Native path: once a structured call is captured we abort and drop the tail.
            // Text path: keep feeding chunks so we can collect a whole batch of calls (RC-7)
            // — the generation runs to its natural end instead of aborting on the first.
            if (pendingCall && !toolParser) return
            // Native function-calling (#15): the gateway assembled a structured tool call.
            // Synthesize the SAME ```myto:tool block the text protocol produces so history,
            // the transcript card, and the loop stay format-agnostic, then end the turn
            // exactly like the text path does on a complete fence. Guarded by `!pendingCall`
            // so a call already captured this generation — a native one whose abort tail is
            // still draining, or a ```myto:tool text call the parser found first now that it
            // runs in native mode too (RC-9) — is never clobbered by a later structured one.
            if (parseTools && chunk.toolCall && !pendingCall) {
              let input: unknown = {}
              let parseErr: string | null = null
              const argsJson = chunk.toolCall.argsJson?.trim()
              if (argsJson) {
                try {
                  input = JSON.parse(argsJson)
                } catch (e) {
                  parseErr = `invalid JSON arguments (${e instanceof Error ? e.message : String(e)})`
                }
              }
              // Unparseable JSON args on a native call are the max_tokens signature: the
              // model streamed a valid-so-far argument object that got cut mid-token, so it
              // no longer parses. Executing it with `{}` (the old behaviour) runs a
              // half-specified action — a write_file with no content, a bogus path — which
              // is exactly the "wrote garbage / didn't persist" symptom. Treat it as a
              // truncation instead: flag it, DON'T set pendingCall, DON'T abort — let the
              // stream reach its terminal `done` so the loop auto-resumes and asks the model
              // to redo the call (writing large files in pieces) rather than executing junk.
              if (parseErr) {
                sawTruncation = true
                return
              }
              const name = chunk.toolCall.name
              pendingCall = {
                block: toolCallBlock(name, input),
                name,
                input,
                error: null
              }
              iter.abort()
              return
            }
            if (chunk.reasoning && !contentStarted) {
              reasoningText += chunk.reasoning
              const now = Date.now()
              if (now - lastReasoningEmit >= REASONING_CAPTION_MS) {
                lastReasoningEmit = now
                // Forward the growing thought itself (renderer counts its tokens and
                // shows it when expanded) plus a short caption for the status line.
                const caption = reasoningCaption(reasoningText)
                if (caption) captionFromReasoning = true
                send({ delta: '', done: false, thinking: reasoningText, ...(caption ? { status: caption } : {}) })
              }
            } else if (chunk.reasoning) {
              // Reasoning that RESUMES after visible content has begun (interleaved-
              // reasoning models). This turn's thinking block is already sealed, so we
              // don't reopen it — but the model IS working, and dropping these frames
              // silently would freeze the renderer's liveness clock into a false stall
              // (the raw frames still re-arm the stall guard, so nothing aborts). A
              // throttled status heartbeat keeps the run honestly alive.
              const now = Date.now()
              if (now - lastReasoningEmit >= HELD_BLOCK_HEARTBEAT_MS) {
                lastReasoningEmit = now
                send({ delta: '', done: false, status: 'Thinking…' })
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
                  // Visible text has begun — seal the thinking block that preceded it.
                  closeThinking()
                }
                emitText(text)
              }
            }
            // The terminal chunk carries `truncated` when the provider reported the model
            // stopped at its output-token limit (OpenAI finish_reason:'length' / Anthropic
            // stop_reason:'max_tokens'). Latch it so the loop auto-resumes — this catches a
            // cut-off that lands mid visible prose (no open tool block), which the held-block
            // check below can't see. `done` is otherwise not handled here — the loop sends it.
            if (chunk.done && chunk.truncated) sawTruncation = true
          }

          // Bounded retry around the generation stream. A busy free-tier endpoint
          // answers with 429 (rate limit) or a transient 5xx *at the headers stage* —
          // before a single token is emitted — so re-issuing the identical request after
          // a short wait is safe and usually succeeds. We retry ONLY while this turn has
          // emitted nothing (so a partial reply can never be duplicated), honour any
          // Retry-After, and keep the user informed with a visible countdown. Exhausted
          // or non-retryable → fall through to the humanized error (toErrorMessage spells
          // out a 429 in plain language and points at Rewrite / another model).
          //
          // Beyond retrying the SAME request, a pristine terminal failure may fail over
          // to a configured second model (settings.fallbackModel) — one-shot, with its
          // own fresh retry budget. `activeModelId` is the model actually streamed; it
          // starts at the requested model and is swapped once if failover fires.
          let activeModelId = modelId
          let triedFallback = false
          for (let attempt = 0; ; attempt++) {
            try {
              await provider.streamCompletion(activeModelId, turnHistory, onProviderChunk, iter.signal, {
                reasoningEffort: effortForRun,
                // Advertise the tool schemas only on a tool-enabled native turn; the closing
                // turn (parseTools=false) and the text protocol never send them.
                ...(parseTools && useNativeTools ? { tools: nativeSchemas } : {})
              })
              break // generation finished cleanly
            } catch (err) {
              if (controller.signal.aborted) {
                controller.signal.removeEventListener('abort', onOuterAbort)
                return { visible, call: null } // user cancel
              }
              if (pendingCall) {
                controller.signal.removeEventListener('abort', onOuterAbort)
                closeThinking()
                // ended early for a tool (native first-call abort, or the text-protocol
                // batch cap) — hand back the whole batch collected so far
                return { visible, call: pendingCall, calls: [pendingCall, ...extraCalls] }
              }
              // Only a pristine turn may be retried; a mid-stream failure keeps its
              // partial output and surfaces the error rather than replaying tokens.
              const pristine = visible === '' && reasoningText === '' && !contentStarted
              const delay = pristine ? rateLimitRetryDelay(err, attempt) : null
              if (delay === null) {
                // Same-request retries are exhausted (or the failure was never retryable).
                // Before surfacing the error, try a one-shot switch to the configured
                // fallback model — pristine only, so no emitted token is ever replayed.
                const fb = planFailover({
                  pristine,
                  err,
                  fallbackModel: settings.fallbackModel,
                  activeModel: activeModelId,
                  triedFallback
                })
                if (fb !== null) {
                  triedFallback = true
                  activeModelId = fb
                  send({ delta: '', done: false, status: `Model unavailable — switching to fallback (${fb})…` })
                  attempt = -1 // ++ → 0: give the fallback its own fresh retry budget
                  continue
                }
                controller.signal.removeEventListener('abort', onOuterAbort)
                return { visible, call: null, error: toErrorMessage(err) }
              }
              // Announce the wait, then sleep — waking early if the user cancels.
              const why = httpStatusOf(err) === 429 ? 'Rate limited' : 'Endpoint busy'
              send({ delta: '', done: false, status: `${why} — retrying in ${Math.ceil(delay / 1000)}s…` })
              const aborted = await new Promise<boolean>((resolve) => {
                if (controller.signal.aborted) return resolve(true)
                const onAbort = (): void => {
                  clearTimeout(t)
                  resolve(true)
                }
                const t = setTimeout(() => {
                  controller.signal.removeEventListener('abort', onAbort)
                  resolve(false)
                }, delay)
                controller.signal.addEventListener('abort', onAbort, { once: true })
              })
              if (aborted) {
                controller.signal.removeEventListener('abort', onOuterAbort)
                return { visible, call: null } // user cancelled during the backoff
              }
              // Clear the countdown caption before the next attempt streams in.
              send({ delta: '', done: false, status: '' })
            }
          }
          controller.signal.removeEventListener('abort', onOuterAbort)

          // Natural end: flush the status stripper's tail through the tool parser,
          // then deal with anything the tool parser was still holding.
          const tail = stripper.flush()
          if (tail) emitText(tail)
          let truncated = false
          if (toolParser && !pendingCall) {
            // A held partial-opener (a lone fence/`<` tail) is benign trailing prose and
            // is released as text. But a leftover that is a *mid-tool-call* block — the
            // stream was cut off (token limit / dropped upstream) before its closing
            // fence — must NOT be forwarded verbatim: the renderer would bake it into a
            // tool card stuck on "Preparing…" forever (the close never comes). Drop the
            // partial invocation (nothing ran) and flag the truncation so the caller can
            // recover.
            const openBlock = toolParser.holdingBlock
            const leftover = toolParser.flush()
            if (openBlock) {
              truncated = true
              // In the agentic loop the caller AUTO-RESUMES a cut-off tool call (see the
              // truncation-recovery branch in the loop), so do NOT surface a dead-end
              // "Send continue" notice there — that hand-back to the user is exactly the
              // premature stop we are removing (the "built one file then Stopped" halt on a
              // big write_file). Only in a plain, non-agentic chat — which has no build loop
              // to resume — do we tell the user how to carry on.
              if (!agentic) {
                const notice =
                  "\n\n⚠️ The model's reply was cut off in the middle of a tool call (it likely hit the output-token limit), so the action didn't run. Send \"continue\" to resume."
                visible += notice
                send({ delta: notice, done: false })
              }
            } else if (leftover) {
              visible += leftover
              send({ delta: leftover, done: false })
            }
          }
          // A turn can reason then emit ONLY a tool call (no visible text), which
          // never trips the content-start close above; seal it here so the phase
          // doesn't stay open and get overwritten by the next turn's reasoning.
          closeThinking()
          // `truncated` = the held-block cut-off (text protocol) OR a provider-reported
          // output-limit / unparseable-native-args truncation (sawTruncation). Either way
          // the loop auto-resumes instead of finishing on a half-written answer.
          return {
            visible,
            call: pendingCall,
            calls: pendingCall ? [pendingCall, ...extraCalls] : undefined,
            truncated: truncated || sawTruncation
          }
        }

        // Base system prompts: <status> narration always, plus (in chat mode only) the
        // file-card protocol. Applied only here, on the interactive stream — the
        // non-streaming getCompletion path (auto-titles) never receives them.
        const baseSystem: ChatMessage[] = [
          // Identity FIRST, in every mode: pins the assistant to "Myto" so the
          // underlying gateway/model never leaks a foreign name (it was answering
          // "Kiro", then "Claude"). See IDENTITY_SYSTEM_PROMPT.
          { role: 'system', content: IDENTITY_SYSTEM_PROMPT },
          { role: 'system', content: STATUS_SYSTEM_PROMPT },
          // The file-card protocol (```lang path fenced blocks → downloadable cards) is a
          // CHAT-ONLY mechanism: plain chat has no filesystem, so a fenced block with a path
          // is the only way to "produce a file the user can save". In the agentic modes
          // (Build/Cowork) that SAME block renders as a display-only card that writes NOTHING
          // to disk — so teaching the protocol there makes the model emit each file as prose
          // first, then re-write it with write_file: the whole file generated TWICE (≈2× the
          // tokens and time — the exact waste the user reported). Those modes have write_file
          // and must use it directly, so the protocol is injected for chat only.
          ...(mode !== 'cowork' && !research
            ? [{ role: 'system' as const, content: FILE_PROTOCOL_SYSTEM_PROMPT }]
            : []),
          // Output style (#13): the user's chosen voice (concise/explanatory/learning),
          // applied in every mode. 'default' yields '' → the turn is omitted entirely.
          ...(outputStyleInstruction
            ? [{ role: 'system' as const, content: outputStyleInstruction }]
            : []),
          // Global user memory applies in every mode; kept in the compaction-protected
          // head so long runs never forget the user's standing preferences.
          ...(userMemory
            ? [
                {
                  role: 'system' as const,
                  content:
                    'USER MEMORY — durable facts and preferences you saved about this user, across all projects. Apply them unless the current request overrides them:\n\n' +
                    userMemory
                }
              ]
            : []),
          // The two agentic modes each get their own working contract. `cowork` (shown as
          // "Build") is the project-builder scoped to the working folder; `research` (shown
          // as "Cowork") is the folderless all-rounder that hands whole-project creation off
          // to Build. Both prompts push proactive sub-agent delegation.
          ...(mode === 'cowork'
            ? [{ role: 'system' as const, content: COWORK_SYSTEM_PROMPT }]
            : research
              ? [{ role: 'system' as const, content: ALLROUNDER_SYSTEM_PROMPT }]
              : []),
          // Video/photo editing (bundled FFmpeg): how to drive the media tools well —
          // probe → gather → one edit plan → render → verify, frames sparingly. Added in
          // both agentic modes once a working folder is set, which is exactly when the
          // media tools (tools/media-edit.ts, gated on fsAvailable) are advertised.
          ...((mode === 'cowork' || research) && workspaceDir
            ? [{ role: 'system' as const, content: MEDIA_EDITING_SYSTEM_PROMPT }]
            : []),
          // Saved credentials (vault): tell the agent which services it already holds keys
          // for — names/scopes/usage only, never a value — so it runs the normal command
          // instead of asking the user to paste a token again. Added in both agentic modes
          // once a working folder has credentials saved (the only place they're scoped to).
          ...(credentialsPrompt
            ? [{ role: 'system' as const, content: credentialsPrompt }]
            : []),
          // Runtime awareness (Track 1): the detected interpreters + the exact command
          // for each, so a weaker model doesn't reach for `python3` on Windows. Sits
          // right after the Cowork prompt that tells it to script deliverables.
          ...(runtimeSummary
            ? [{ role: 'system' as const, content: `RUNTIMES — ${runtimeSummary}` }]
            : []),
          // Browser (Track 2): the navigate → snapshot → act loop over the browser_* tools,
          // added (in Chat AND Cowork) whenever a browser target other than `off` is armed —
          // and always in Research, where the effective target arms in-app by default.
          // For system-chrome it also carries the real-logins safety caution.
          ...(browserToolsEnabled(effSettings.cowork.browserTarget)
            ? [
                {
                  role: 'system' as const,
                  content: coworkBrowserPrompt(effSettings.cowork.browserTarget)
                }
              ]
            : []),
          // Plan mode (#8): plan-first directive, right after the Cowork agent prompt so
          // it overrides the "ACT, don't narrate" bias until the user approves the plan.
          // The explicit toggle gets the firm PLAN_MODE prompt; the auto-detected big-task
          // path gets the lighter AUTO_PLAN prompt (which lets the model skip planning if
          // the task turns out small), so toggle-off never nags a one-liner.
          ...(planActive
            ? [{ role: 'system' as const, content: autoPlan ? AUTO_PLAN_SYSTEM_PROMPT : PLAN_MODE_SYSTEM_PROMPT }]
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
            : []),
          // Attached files (Cowork): the user's uploads for THIS turn, already copied
          // into the working folder. Tell the agent exactly where they are so it reads
          // them directly instead of reporting it "couldn't find" the file.
          ...(attachedFiles.length > 0
            ? [
                {
                  role: 'system' as const,
                  content:
                    'ATTACHED FILES — the user attached these to their message and they are NOW in your working folder under uploads/. Open them directly at the paths below (e.g. read_file, or run code over them); do NOT say you cannot find them and do NOT search elsewhere:\n' +
                    attachedFiles.map((f) => `- ${f.rel} (${f.mime}, ${f.size} bytes)`).join('\n')
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
          // Native mode omits the text-protocol instructions entirely (the model gets the
          // tool schemas out-of-band); the text path still teaches the ```myto:tool fence.
          ...(useNativeTools ? [] : [{ role: 'system' as const, content: toolsPrompt }]),
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
        const goalLine = goal
          ? `Remember, the user's request is: "${goal.length > 500 ? `${goal.slice(0, 500)}…` : goal}"\n\n`
          : ''
        const goalReminder = goalLine
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
        // Research-stall guard (Cowork): a run of read-only research calls (web/browser/
        // fs inspection) across DISTINCT targets — the exact loop the screenshot showed,
        // and the one every signature-keyed guard misses because no single call repeats.
        // Counts consecutive research calls with nothing built in between; any building
        // action resets it. See {@link researchStallVerdict}.
        let researchStreak = 0
        // How many times we've told the model "you printed code but didn't save it"
        // this reply. Capped at one nudge so a model that legitimately meant to only
        // show code (or ignores the nudge) can't be trapped in a loop.
        let codeProseNudges = 0
        // Auto-persist ledger (Cowork, RC-5): content signatures of narrated code blocks
        // we've already written to disk ourselves. A weaker model often NARRATES a file's
        // full contents in a fence instead of calling write_file, then marks its plan item
        // "done" and moves on — so nudging never lands the file. When a silent turn carries
        // a confidently-named block, we write it directly (a synthesized write_file through
        // runTool, same sandbox + journaling as the model's own call) rather than only
        // asking. This set dedupes so the identical block, re-narrated on a later turn,
        // isn't written twice; a genuinely-changed body has a new signature and is saved.
        const autoPersistedSigs = new Set<string>()

        // Cross-turn narrated-file accumulator (Cowork, RC-8). Every file the model prints
        // in a fence — in ANY turn, not just the silent one that trips auto-persist — is
        // captured here (path → most-recent body). RC-5 auto-persist only ever sees the
        // CURRENT turn's reply, so a file narrated on an early turn (then buried under later
        // tool calls) that never got written is invisible to it; the run-1 e2e lost app.js
        // exactly this way. Filesystem reconciliation reads this ledger to materialize a
        // planned-but-missing file from whatever body the model last showed for it. Later
        // (more complete) narration wins, mirroring {@link extractNarratedFiles}.
        const narratedAcc = new Map<string, string>()

        // Deliberation guard: consecutive `think`-tool calls with no real action between
        // them (see MAX_THINK_STREAK). Reset the moment any other tool runs, so thinking
        // interleaved with acting is unlimited and only a think-only spin is checked.
        let thinkStreak = 0

        // Windowed oscillation guard (Cowork): the rolling tool-call signatures and how
        // many times we've nudged the model to break a NON-consecutive repeat loop
        // (A,B,A,B,A…) this reply — capped at one nudge, then the loop stops. Complements
        // the consecutive-repeat guard below, which only catches back-to-back identical
        // calls. See {@link detectOscillation}.
        const recentSigs: string[] = []
        let oscillationNudges = 0

        // Auto-continue guard (Cowork): how many times we've pushed the model past a soft
        // "should I continue?" prose-stop this reply. Capped by {@link MAX_AUTO_CONTINUE}
        // so a genuine need-input pause isn't looped forever — after the cap the reply
        // stands and the user can weigh in.
        let autoContinues = 0

        // Announced-action guard (Cowork): how many times we've pushed the model past a
        // reply that ENDS by announcing a build step ("Now I'm building index.html…") it
        // never actually performed — no tool call followed. Capped by
        // {@link MAX_ANNOUNCED_ACTION} so a genuinely-finished reply isn't looped.
        let announcedActionNudges = 0

        // False-limit / deferral guard (Cowork): how many times we've pushed the model
        // past a reply that abandons the run by inventing a tool/usage limit or deferring
        // the work to a "next turn" instead of finishing or acting. Capped by
        // {@link MAX_FALSE_LIMIT_DEFERRAL} so a genuinely-finished reply isn't looped.
        let falseLimitDeferralNudges = 0

        // Empty-reply guard (Cowork): how many times we've turned a content-free reply
        // (empty / whitespace / stray marks, no tool call) back into "take the next action"
        // — whether the run built nothing yet OR built some files and then fell silent
        // mid-project. Capped by {@link MAX_EMPTY_START} so a task that genuinely needs no
        // (more) files isn't looped — after the cap the (empty) reply stands.
        let emptyStartNudges = 0

        // Truncation-recovery guard (agentic): how many times this reply we've auto-resumed
        // a tool call the model cut off mid-stream at the output-token limit. Reset by any
        // completed tool call, so the cap counts only CONSECUTIVE cut-offs with no progress
        // between them. Capped by {@link MAX_TRUNCATION_CONTINUES} so a file that truncates
        // forever can't loop endlessly — after the cap the run surfaces the notice and stops.
        let truncationContinues = 0

        // Plan-completion guard (agentic, RC-1): how many times this reply we've caught the
        // model ENDING with no tool call while its own plan (update_plan) still has pending
        // items, and pushed it to finish them. This is the headline "stops midway" stall — a
        // model builds a couple of steps, marks nothing done, then falls silent at plan 1/4.
        // Reset by any completed tool call (like {@link truncationContinues}) so the cap
        // counts only CONSECUTIVE premature stops with no progress between them; bounded by
        // {@link MAX_PLAN_INCOMPLETE} so a plan the model can't finish can't loop forever.
        let planIncompleteNudges = 0

        // Verify gate state (#16): how many times the verify command has run this reply,
        // and whether it has passed (so a later natural-done doesn't re-run it needlessly).
        let verifyRounds = 0
        let verifyPassed = false

        // Build-complete visual-review state: how many times this reply has screenshot-reviewed
        // the preview. Capped at {@link MAX_VISUAL_REVIEWS} (1) so the look-at-your-work pass
        // fires once and the run then finishes — it can never become an endless polish loop.
        let visualReviewsDone = 0

        // Plan-mode gate state (#8): whether the user has approved the drafted plan this
        // reply. Until then the FIRST side-effecting tool is held for plan approval.
        let planApproved = false

        // Batched-call queue (RC-7): tool calls the model emitted AFTER the first in a
        // single generation. runTurn hands back the whole batch; we run the first as the
        // current turn's call and enqueue the rest here, draining one per loop iteration
        // WITHOUT re-generating. This is what lets a reply of "write a; write b; write c;
        // update_plan(all done)" actually mark the plan done — the old loop ran only
        // write a and threw the other three away, so the plan never left its initial state.
        const carriedCalls: ToolCall[] = []

        // Wall-clock anchor for the agentic budget ({@link COWORK_TIME_BUDGET_MS}):
        // a slow endpoint makes per-turn time the real cost, so the loop also ends
        // on elapsed time, not just on the turn cap.
        const runStartedAt = Date.now()
        // Which budget ended the loop, for the finish trace below ('turn-budget' is
        // also what the think/repeat/oscillation/research-stall breaks fall through to).
        let budgetReason: 'turn-budget' | 'time-budget' = 'turn-budget'

        for (let turn = 0; turn < maxToolTurns; turn++) {
          // Time budget (agentic): when the reply has been running longer than the
          // wall-clock budget, stop making NEW tool calls and fall through to the
          // closing turn below, which answers with what the run already has. This is
          // the hard bound that turns the old "runs for 10 hours" failure into a
          // bounded, predictable reply.
          if (agentic && Date.now() - runStartedAt > COWORK_TIME_BUDGET_MS) {
            budgetReason = 'time-budget'
            break
          }
          // Keep the running history inside the context window on long tasks: once it
          // grows past the threshold, fold the older middle into a short summary so the
          // loop can continue instead of eventually overflowing the model. Agentic modes
          // only (Cowork/Research) — a plain-chat tool loop is short and never reaches
          // this. The ceiling is per provider: large for remote BYOK endpoints (whose
          // windows are 128k+), small for local Ollama models (often 8–32k).
          if (
            agentic &&
            historyChars(history) >
              (isLocalOllama ? COMPACT_OVER_CHARS_LOCAL : COMPACT_OVER_CHARS_REMOTE)
          ) {
            await compactMiddle(history, baseLen, provider, modelId, controller.signal)
            if (controller.signal.aborted) return
          }

          // Drain a call the model batched into an EARLIER generation before spending a new
          // one (RC-7). A carried call is replayed with no fresh visible prose (its prose was
          // already streamed on the generating turn); when the queue empties we generate the
          // next turn and enqueue anything past the first call it returns.
          let visible = ''
          let call: ToolCall | null = null
          let error: string | undefined
          let truncated: boolean | undefined
          if (carriedCalls.length > 0) {
            call = carriedCalls.shift() ?? null
          } else {
            const r = await runTurn(history, true)
            visible = r.visible
            call = r.call
            error = r.error
            truncated = r.truncated
            if (r.calls && r.calls.length > 1) carriedCalls.push(...r.calls.slice(1))
          }
          if (controller.signal.aborted) return
          // Capture any file the model narrated in a fence this turn into the cross-turn
          // ledger (RC-8), so reconciliation can later write a planned file the model only
          // ever showed in chat. Idempotent: re-seeing the same body just re-sets the entry.
          if (mode === 'cowork' && workspaceDir) {
            for (const f of extractNarratedFiles(visible)) narratedAcc.set(f.path, f.content)
          }
          // Count raw tool-fence markers in the visible reply. Content-free: it tells a trace
          // whether parseable call blocks LEAKED into the reply text (a parser/echo problem)
          // vs the model simply stopping without emitting a block (a model problem) — the two
          // have opposite fixes, and this is the one signal that separates them in a live run.
          const leakedMarkers = visible.split('```myto:tool').length - 1
          // One structural line per turn (gated): the model's stop shape and the live plan
          // state, so a premature stop is legible in a trace without leaking any content.
          agentTrace('turn', {
            turn,
            tool: call?.name ?? null,
            truncated: !!truncated,
            error: !!error,
            visibleLen: visible.length,
            leakedMarkers,
            queued: carriedCalls.length,
            planDone: latestPlan.filter((t) => t.status === 'done').length,
            planTotal: latestPlan.length
          })
          if (error) {
            agentTrace('finish', { reason: 'error', turn })
            send({ delta: '', done: true, error })
            return
          }
          if (!call) {
            // Truncation recovery (agentic) — checked FIRST, before every "did it really
            // finish?" guard below. The model's reply was cut off in the MIDDLE of a tool
            // call: it hit the output-token limit before the closing fence, so the partial
            // call was dropped and nothing ran. This is the "built one file then Stopped"
            // mid-project halt on a large write_file (and any oversized tool block). Rather
            // than ending the run and making the user type "continue", re-ask the model to
            // re-issue that exact call in full — and, for a large file, to write it in parts
            // (an initial write_file, then append the rest with edit_file) so it stops
            // re-truncating at the same point — then loop on with tools still live. Bounded
            // by {@link MAX_TRUNCATION_CONTINUES} consecutive cut-offs (any completed tool
            // call resets the counter) so a file that keeps truncating can't spin forever.
            if (agentic && truncated) {
              if (truncationContinues < MAX_TRUNCATION_CONTINUES) {
                truncationContinues++
                send({ delta: '', done: false, status: 'Output limit hit — resuming automatically' })
                if (visible.trim()) history.push({ role: 'assistant', content: visible })
                history.push({
                  role: 'user',
                  content: `${goalReminder}Your previous reply was cut off by the output-token limit in the MIDDLE of a tool call, so that action did NOT run and nothing from it was saved. Re-issue that tool call now, from the start, with its FULL contents. IMPORTANT: to avoid hitting the same limit again, do not emit one enormous block — if the file is large, first call write_file with the opening portion, then append each remaining portion with edit_file (successive edit_file calls are fine), keeping every single tool call comfortably under the output limit. Continue one tool call at a time until every file is fully written and the task is complete.`
                })
                continue
              }
              // Cap reached — the model keeps truncating even when asked to chunk (files
              // too large, or a very low upstream output cap). Surface the honest notice
              // and let the run stop so the user can weigh in, rather than spinning forever.
              const notice =
                "\n\n⚠️ The reply kept getting cut off at the output-token limit even after retrying in smaller pieces, so the last action may be incomplete. Send \"continue\" to resume."
              agentTrace('finish', { reason: 'truncation-cap', turn })
              send({ delta: notice, done: false })
              send({ delta: '', done: true })
              return
            }
            // Filesystem reconciliation (Cowork, RC-8) — the model-independent backstop, run
            // BEFORE every cooperation-dependent nudge below so they all operate on a plan
            // that matches the real disk. Two failure modes the nudges never reliably fix:
            // (a) the model narrated a planned file in chat and never wrote it (run-1 lost
            // app.js this way — narrated on an early turn, invisible to the current-turn-only
            // auto-persist); (b) files exist on disk but the plan still reads pending because
            // the model forgot update_plan (the "plan stays 0/N" headline). We (1) materialize
            // any planned-but-missing file from the cross-turn narration ledger via the same
            // sandboxed write_file path, then (2) mark every file-target plan item done whose
            // file actually exists, and (3) only once all file deliverables exist (and any
            // verify command has passed) mark residual verify/preview steps done — never
            // claiming a headless "preview" happened. Nothing here depends on the model
            // cooperating, so a run can finish truthfully even when the model won't.
            if (agentic && mode === 'cowork' && workspaceDir && latestPlan.length > 0) {
              const rcVerifyCmd = settings.cowork.verifyCommand.trim()
              const existsNonEmpty = (rel: string): boolean => {
                const abs = resolveInWorkspace(workspaceDir, rel)
                if (!abs) return false
                try {
                  return statSync(abs).size > 0
                } catch {
                  return false
                }
              }
              // Step 1: write planned-but-missing files captured from earlier narration.
              const toWrite: { path: string; content: string }[] = []
              for (const item of latestPlan) {
                if (item.status === 'done') continue
                const target = planFileTarget(item.title)
                if (!target || existsNonEmpty(target)) continue
                const content = narratedAcc.get(target)
                if (content == null || autoPersistedSigs.has(`${target}\u0000${content}`)) continue
                if (!toWrite.some((w) => w.path === target)) toWrite.push({ path: target, content })
              }
              const reconciledWrites: string[] = []
              if (toWrite.length > 0) {
                let approvedWrite = true
                if (!grantedAlways.has('write') && requiresApproval(permissionMode, 'write')) {
                  send({ delta: '', done: false, status: 'Waiting for your approval' })
                  const decision = await requestApproval(
                    'write_file',
                    'write',
                    `Save ${toWrite.length} planned file(s) not yet on disk: ${toWrite.map((w) => w.path).join(', ')}`
                  )
                  if (controller.signal.aborted) return
                  if (decision === 'allow_always') grantedAlways.add('write')
                  approvedWrite = decision !== 'deny'
                }
                if (approvedWrite) {
                  for (const w of toWrite) {
                    const synth: ToolCall = { block: '', name: 'write_file', input: { path: w.path, content: w.content }, error: null }
                    const res = await runTool(synth, {
                      ...gate,
                      signal: controller.signal,
                      onPreview, onPlan, onCommand, onFileSnapshot,
                      delegate, askUser, preToolUse, postToolUse, getBrowser, renderDocument
                    })
                    if (controller.signal.aborted) return
                    autoPersistedSigs.add(`${w.path}\u0000${w.content}`)
                    recordToolAction(workspaceDir, synth, res)
                    buildsMade++
                    exploreStreak = 0
                    researchStreak = 0
                    reconciledWrites.push(w.path)
                    send({ delta: toolResultBlock('write_file', res), done: false, status: `Saved ${w.path}` })
                    agentTrace('reconcile-write', { turn, path: w.path, lines: w.content.split('\n').length })
                  }
                }
              }
              // Steps 2 & 3: mark the plan from real disk state. A file-target step is done
              // once its file exists non-empty; a verify/preview step is done only once EVERY
              // file deliverable exists and any configured verify command has passed.
              const fileItems = latestPlan.filter((t) => planFileTarget(t.title))
              const allFilesExist =
                fileItems.length > 0 && fileItems.every((t) => existsNonEmpty(planFileTarget(t.title) as string))
              let reconciledMarks = 0
              const nextPlan: TodoItem[] = latestPlan.map((t) => {
                const target = planFileTarget(t.title)
                if (target && t.status !== 'done' && existsNonEmpty(target)) {
                  reconciledMarks++
                  return { ...t, status: 'done' }
                }
                if (isVerifyStep(t.title) && t.status !== 'done' && allFilesExist && (!rcVerifyCmd || verifyPassed)) {
                  reconciledMarks++
                  return { ...t, status: 'done' }
                }
                return t
              })
              if (reconciledMarks > 0) onPlan(nextPlan)
              if (reconciledWrites.length > 0 || reconciledMarks > 0) {
                agentTrace('reconcile', {
                  turn,
                  wrote: reconciledWrites.length,
                  marked: reconciledMarks,
                  planDone: nextPlan.filter((t) => t.status === 'done').length,
                  planTotal: nextPlan.length
                })
              }
              if (reconciledWrites.length > 0) {
                // We wrote real files the model had only narrated — tell it what changed and
                // press on, so it continues from a disk-truthful state, not by re-narrating.
                if (visible.trim()) history.push({ role: 'assistant', content: visible })
                history.push({
                  role: 'user',
                  content: `${goalReminder}Some files your plan requires existed only as text in your reply, not on disk, so I saved them for you: ${reconciledWrites.join(', ')}. Never paste file contents into chat — always call write_file yourself. Continue: take the next concrete action for any remaining step, and mark a plan item done only once its file actually exists on disk.`
                })
                continue
              }
              // No writes were needed. If marking alone closed the plan we fall through to the
              // verify gate / finish below, now judging a plan that matches the filesystem.
            }
            // Code-as-prose guard + AUTO-PERSIST (RC-5). In Cowork the deliverable is
            // files on disk, but a weaker model routinely prints a file's FULL contents in
            // a fence and moves on — often even marking its plan item "done" — without ever
            // calling write_file, so nothing is saved. Nudging alone never reliably fixes
            // this (the model narrates the next file too, and laundered the progress
            // counters via read-only calls). So when a silent turn carries confidently-
            // named code blocks, we WRITE them ourselves: a synthesized write_file run
            // through the same runTool path (same resolveInWorkspace sandbox, onFileSnapshot
            // preview, and journaling as a model call), honoring the permission tier and
            // deduped by content signature so the identical block re-narrated later isn't
            // rewritten. Only when nothing is confidently named do we fall back to nudging,
            // still bounded by MAX_CODE_PROSE_NUDGES and reset on each real write.
            if (mode === 'cowork' && workspaceDir && looksLikeUnsavedCode(visible)) {
              const narrated = extractNarratedFiles(visible).filter(
                (f) => !autoPersistedSigs.has(`${f.path}\u0000${f.content}`)
              )
              if (narrated.length > 0) {
                let approvedWrite = true
                if (!grantedAlways.has('write') && requiresApproval(permissionMode, 'write')) {
                  send({ delta: '', done: false, status: 'Waiting for your approval' })
                  const decision = await requestApproval(
                    'write_file',
                    'write',
                    `Save ${narrated.length} file(s) shown in chat: ${narrated.map((f) => f.path).join(', ')}`
                  )
                  if (controller.signal.aborted) return
                  if (decision === 'allow_always') grantedAlways.add('write')
                  approvedWrite = decision !== 'deny'
                }
                if (approvedWrite) {
                  const saved: string[] = []
                  for (const f of narrated) {
                    const synth: ToolCall = { block: '', name: 'write_file', input: { path: f.path, content: f.content }, error: null }
                    const res = await runTool(synth, {
                      ...gate,
                      signal: controller.signal,
                      onPreview, onPlan, onCommand, onFileSnapshot,
                      delegate, askUser, preToolUse, postToolUse, getBrowser, renderDocument
                    })
                    if (controller.signal.aborted) return
                    autoPersistedSigs.add(`${f.path}\u0000${f.content}`)
                    recordToolAction(workspaceDir, synth, res)
                    buildsMade++
                    exploreStreak = 0
                    researchStreak = 0
                    saved.push(f.path)
                    send({ delta: toolResultBlock('write_file', res), done: false, status: `Saved ${f.path}` })
                    agentTrace('autopersist', { turn, path: f.path, lines: f.content.split('\n').length })
                  }
                  history.push({ role: 'assistant', content: visible })
                  history.push({
                    role: 'user',
                    content: `${goalReminder}I found file contents in your reply that you never saved, so I wrote them to disk for you: ${saved.join(', ')}. Never paste file contents into chat again — always call write_file yourself. Continue now: take the next concrete action (write the next file, or verify), and only mark a plan item done once its file actually exists on disk.`
                  })
                  continue
                }
              }
              // Nothing confidently named (or the write was denied): fall back to nudging
              // the model to save it itself, bounded so it can't loop forever.
              if (codeProseNudges < MAX_CODE_PROSE_NUDGES) {
                codeProseNudges++
                send({ delta: '', done: false, status: 'Saving the code to a file' })
                history.push({ role: 'assistant', content: visible })
                history.push({
                  role: 'user',
                  content: `${goalReminder}You wrote code in your reply but never saved it — it only exists in this chat, so the user cannot run or keep it. In Cowork you MUST create files with the write_file tool. Call write_file now with the correct path and the FULL contents of the file(s) you just showed. If you genuinely only meant to illustrate something and no file should be created, say so explicitly instead.`
                })
                continue
              }
            }
            // Auto-continue past a soft "should I continue?" stop (Cowork). At extreme
            // scale a model often PAUSES to ask whether to keep going instead of just
            // finishing — for an autonomous builder that reads as a stall, not a real
            // question. If the reply is a rhetorical permission-to-continue ask (not a
            // genuine either/or, which wouldn't match), push it onward and loop with tools
            // still live. Bounded by MAX_AUTO_CONTINUE so a model that truly needs a
            // decision isn't trapped: after the cap the reply stands so the user can answer.
            if (
              agentic &&
              workspaceDir &&
              autoContinues < MAX_AUTO_CONTINUE &&
              looksLikeContinuationRequest(visible)
            ) {
              autoContinues++
              send({ delta: '', done: false, status: 'Continuing automatically' })
              history.push({ role: 'assistant', content: visible })
              history.push({
                role: 'user',
                content: `${goalReminder}Yes — continue, and don't stop to ask whether to proceed. As an autonomous agent you keep working until the request is fully handled and verified. If you genuinely need a decision only the user can make, call the ask_user tool instead of asking in prose. Take the next concrete action now.`
              })
              continue
            }
            // Announced-but-unexecuted action (Cowork). The commonest half-finished-run
            // stall: the model builds one file, then ENDS its reply narrating the next
            // step ("Now I'm building index.html…") without emitting the tool call — so
            // nothing is written and the loop, seeing no call, reads the turn as done and
            // stops mid-project. Every other guard misses it (a file WAS written, so it is
            // no explore-only spin; nothing repeats, so it is no oscillation; it prints no
            // code, so the unsaved-code guard is silent). Detect the announcement off the
            // reply's tail and push the model to actually perform it, tools still live.
            // Bounded by MAX_ANNOUNCED_ACTION so a genuinely-finished reply that merely
            // mentions a follow-up isn't trapped: after the cap the reply stands.
            if (
              agentic &&
              workspaceDir &&
              announcedActionNudges < MAX_ANNOUNCED_ACTION &&
              looksLikeAnnouncedAction(visible)
            ) {
              announcedActionNudges++
              send({ delta: '', done: false, status: 'Carrying out the announced step' })
              history.push({ role: 'assistant', content: visible })
              history.push({
                role: 'user',
                content: research
                  ? `${goalReminder}You described a next step you were about to take (checking a page, grabbing a snapshot, reading, searching, or opening something) but never actually called a tool to do it — so it didn't happen and no progress was made. Do it now: emit the actual tool call (a browser_* action, web_search, web_fetch, read_file, run_code …) that carries out the step you just described. Don't merely narrate it. If the task is genuinely, fully handled, give the user your final answer and stop.`
                  : `${goalReminder}You described an action you were about to take (e.g. building or writing a file) but never actually called a tool to do it, so nothing was created — the work is only announced, not done. Do it now: emit the tool call (write_file / edit_file / run_command …) that carries out the step you just described, with the full contents. Don't merely narrate it. If the project is genuinely complete, say so explicitly and stop.`
              })
              continue
            }
            // False-limit / deferral give-up (Cowork). A weak model sometimes abandons a
            // run by INVENTING a stop condition — "the tool-use limit was reached … the
            // implementation remains pending for the next available tool-enabled turn" —
            // and stops with nothing built. It is always a confabulation: there is no
            // per-reply tool cap (the ceiling is unbounded), and a real cap would tell the
            // model to answer with what it has, never to defer. No other guard catches it
            // (nothing was built, so it's no announced-action; nothing repeats; it prints
            // no code; it's not a question). Detect the excuse and push the model to act
            // now, tools still live. Bounded by MAX_FALSE_LIMIT_DEFERRAL, with an explicit
            // escape hatch so a genuinely-complete reply that trips it can just confirm.
            if (
              agentic &&
              workspaceDir &&
              falseLimitDeferralNudges < MAX_FALSE_LIMIT_DEFERRAL &&
              looksLikeFalseLimitDeferral(visible)
            ) {
              falseLimitDeferralNudges++
              send({ delta: '', done: false, status: 'Continuing the build' })
              history.push({ role: 'assistant', content: visible })
              history.push({
                role: 'user',
                content: `${goalReminder}You have a generous tool budget (a hundred+ calls) — there is no limit forcing you to stop now, and a real budget notice would come from the system, never from you. Do not defer the work to a "next turn" and do not claim a limit or quota was reached; that is not true here. Take the next concrete action NOW: emit the tool call (write_file / edit_file / run_command …) that moves the project forward, with the full file contents. If the project is genuinely, fully complete, say so explicitly and stop.`
              })
              continue
            }
            // Empty / content-free reply (Cowork) — the subtlest stall, in TWO shapes:
            //   • NON-START (buildsMade === 0): the model narrated an intention and/or a
            //     few `think` calls, then closed its turn blank — nothing built, ever.
            //   • MID-BUILD (buildsMade > 0): the model built one or more files, then closed
            //     a LATER turn blank while the project is still half-done — the round-3
            //     buildsMade===0 gate let this slip straight through to "done", ending a run
            //     with a PARTIAL project (the observed "built data.js then went silent"
            //     stall). An empty reply — no letter or digit anywhere, no tool call — is
            //     NEVER a real completion in either shape, and every text-keyed guard above
            //     is silent on emptiness. Push the model to act, tools still live, bounded by
            //     MAX_EMPTY_START, with an escape hatch so a task that needs nothing more can
            //     just say so. The message adapts to whether anything has been built yet.
            if (
              agentic &&
              workspaceDir &&
              emptyStartNudges < MAX_EMPTY_START &&
              looksLikeContentFreeReply(visible)
            ) {
              emptyStartNudges++
              send({
                delta: '',
                done: false,
                status: research
                  ? 'Taking the next step'
                  : buildsMade === 0
                    ? 'Starting the build'
                    : 'Continuing the build'
              })
              // Skip pushing an empty assistant turn (some providers reject empty content);
              // only record it if it actually carried a stray mark.
              if (visible.trim()) history.push({ role: 'assistant', content: visible })
              history.push({
                role: 'user',
                content: research
                  ? `${goalReminder}Your reply was empty — no words and no tool call — but the user's request is not resolved. An empty turn is never a valid place to stop. Take the next concrete step NOW: call a tool (read a file, list a folder, search, browse with the browser_* tools, run_code, or write_file) to make progress, or give the user a real answer. Thinking alone is not enough — you must emit an actual tool call or a substantive reply. If the request is genuinely, fully handled, say so explicitly in a sentence and stop.`
                  : buildsMade === 0
                    ? `${goalReminder}Your reply was empty and you have not created a single file yet — the project has not been started. Do NOT end your turn without acting. Take the first concrete step NOW: call update_plan with the concrete steps, then immediately call write_file to create the first real file with its FULL contents, and keep going one tool call at a time until every file exists. Thinking is not enough — you must emit actual tool calls. If the request genuinely requires no files at all, say so explicitly in a sentence and stop.`
                    : `${goalReminder}Your reply was empty — no words and no tool call — but the project is NOT finished: you have taken ${buildsMade} build step${buildsMade === 1 ? '' : 's'} so far and more of the requested files and features still remain. An empty turn is never a valid place to stop. Take the next concrete step NOW: emit the next tool call (write_file / edit_file / run_command …) with the FULL file contents, and keep going one tool call at a time until everything the request asks for exists and works. Thinking is not enough — you must emit actual tool calls. If the project is genuinely, fully complete, say so explicitly in a sentence and stop.`
              })
              continue
            }
            // Plan-completion gate (RC-1) — the headline "stops midway" stall. The model
            // ends a turn with NO tool call while its own update_plan list still has
            // unfinished items (e.g. it wrote one file, left the plan at 1/4, then fell
            // silent). None of the text-shape guards above catch this: the reply can be a
            // confident, well-formed "here's what I built" summary that merely happens to be
            // premature. Treat an incomplete plan as proof the run is not done — list the
            // still-pending steps back to the model and tell it to either carry them out with
            // tool calls, or, for any step already handled, mark it done via update_plan so
            // the plan reflects reality. Bounded by {@link MAX_PLAN_INCOMPLETE} CONSECUTIVE
            // premature stops (reset by any completed tool call); after the cap the reply
            // stands so the user can step in rather than looping a plan the model can't close.
            if (
              agentic &&
              workspaceDir &&
              planIncompleteNudges < MAX_PLAN_INCOMPLETE &&
              planHasPending(latestPlan)
            ) {
              planIncompleteNudges++
              const pending = pendingPlanTitles(latestPlan)
              send({
                delta: '',
                done: false,
                status: `Finishing the plan (${pending.length} step${pending.length === 1 ? '' : 's'} left)`
              })
              if (visible.trim()) history.push({ role: 'assistant', content: visible })
              const list = pending.map((t) => `- ${t}`).join('\n')
              history.push({
                role: 'user',
                content: `${goalReminder}You stopped, but your OWN plan still has unfinished steps:\n\n${list}\n\nThe task is NOT complete until every plan item is done. Take the next concrete step NOW: emit the tool call (${
                  research
                    ? 'browser_* action, web_search, web_fetch, read_file, run_code …'
                    : 'write_file / edit_file / run_command …'
                }) that carries out the first unfinished step above, with its FULL contents, and keep going one tool call at a time. As you finish each step, call update_plan to mark it done. If a listed step is in fact already complete or genuinely not needed, call update_plan now to mark it done so the plan reflects reality — do not merely say so in prose.`
              })
              continue
            }
            // Build-complete visual self-review — "look at what you built" before declaring
            // done. If this Cowork run produced something viewable, open its preview,
            // screenshot that preview offscreen, and hand the picture back so the model can
            // catch layout/style bugs a text-only view misses — then the verify gate below
            // proves the fixes are green. Runs at most MAX_VISUAL_REVIEWS (1) times, so it
            // finishes decisively rather than looping; only in Cowork, and only when a preview
            // target resolves (a page it built, or a dev server it left up) — a non-web
            // deliverable has nothing to look at and skips straight to verify/finish.
            if (
              agentic &&
              mode === 'cowork' &&
              workspaceDir &&
              visualReviewsDone < MAX_VISUAL_REVIEWS
            ) {
              // Last resort when nothing was previewed and no server is up: a built HTML entry.
              let existingEntry: ExistingEntry | null = null
              for (const rel of PREVIEW_ENTRY_CANDIDATES) {
                const abs = resolveInWorkspace(workspaceDir, rel)
                if (abs && statSync(abs, { throwIfNoEntry: false })?.isFile()) {
                  existingEntry = { rel, url: pathToFileURL(abs).toString() }
                  break
                }
              }
              const target = pickReviewTarget({
                lastPreview,
                runningServerUrl: runningServerUrl(workspaceDir),
                existingEntry
              })
              if (target) {
                visualReviewsDone++
                onPreview(target) // raise it in the user's pane — SHOW the finished project
                send({ delta: '', done: false, status: 'Reviewing the preview' })
                const shot = await capturePreviewImage(target.url, controller.signal)
                if (controller.signal.aborted) return
                if (shot) {
                  if (visible.trim()) history.push({ role: 'assistant', content: visible })
                  send({
                    delta: '',
                    done: false,
                    media: [
                      {
                        kind: 'image' as const,
                        mediaType: shot.mediaType,
                        dataBase64: shot.dataBase64,
                        prompt: `Preview — ${target.title}`
                      }
                    ]
                  })
                  history.push({
                    role: 'user',
                    content: visualReviewInstruction(goalReminder, target.title),
                    images: [shot]
                  })
                  continue
                }
                // Capture failed or came back blank — never block the finish on a flaky
                // screenshot; fall through to the verify gate and finish exactly as before.
              }
            }
            // #16 Programmatic verify gate. Before accepting "done" in Cowork, run the
            // user's verify command (build/test/lint). Exit 0 → the run really is done;
            // non-zero → feed the failure back as a user turn and loop so the tools stay
            // live for a fix. Bounded by MAX_VERIFY_ROUNDS (and the turn budget); an empty
            // command, or a command that already passed this reply, is a no-op.
            const verifyCmd =
              mode === 'cowork' && workspaceDir ? settings.cowork.verifyCommand.trim() : ''
            if (verifyCmd && !verifyPassed && verifyRounds < MAX_VERIFY_ROUNDS) {
              verifyRounds++
              send({ delta: '', done: false, status: `Verifying: ${verifyCmd}` })
              const spec = resolveShell()
              const vr = await executeArgv(spec.cmd, [spec.flag, verifyCmd], controller.signal, {
                cwd: workspaceDir ?? undefined,
                timeoutMs: VERIFY_TIMEOUT_MS
              })
              if (controller.signal.aborted) return
              const report = formatRunResult('bash', vr, VERIFY_TIMEOUT_MS)
              // Mirror to the Terminal pane like any other command.
              onCommand({
                command: verifyCmd,
                output: report,
                exitCode: vr.exitCode ?? null,
                cwd: workspaceDir ?? undefined
              })
              if (!vr.spawnError && vr.exitCode === 0) {
                verifyPassed = true
                agentTrace('finish', { reason: 'verify-pass', turn, planTotal: latestPlan.length })
                send({ delta: '', done: true })
                return
              }
              // Failed — surface it and continue so the model can fix the cause.
              history.push({
                role: 'user',
                content: `${goalReminder}The verify command \`${verifyCmd}\` did not pass (exit ${
                  vr.exitCode ?? 'n/a'
                }). Fix the underlying problem, then it will run again automatically:\n\n${report}`
              })
              continue
            }
            // Nothing above intervened: no tool call, not truncated, no shape-guard match,
            // no pending plan item, and verify (if any) has passed — the run is genuinely
            // complete. This is the ONLY unforced finish of the agentic loop.
            agentTrace('finish', {
              reason: 'complete',
              turn,
              planDone: latestPlan.filter((t) => t.status === 'done').length,
              planTotal: latestPlan.length
            })
            send({ delta: '', done: true })
            return
          }

          // A tool was called. The parser consumed the call block (it never
          // reached the reply), so write it to the transcript now, run the tool,
          // then stream the result block onto the same card.
          const toolName = call.name ?? 'tool'

          // The `think` tool is deliberation, not an action. Rather than a tool card and a
          // result block, surface the thought on the SAME out-of-band "thinking" channel the
          // provider's own reasoning stream uses — so tapping the thinking block shows exactly
          // what the model reasoned and which decisions it made — then feed a terse ack back and
          // loop, so it thinks and THEN acts within the one reply. This is the "think tool"
          // pattern: structured room to plan/reflect mid-loop without polluting the visible
          // answer, which is the lever behind "agi-level thinking power through tool calling".
          if (call.name === 'think') {
            const thought = thinkText(call.input)
            thinkStreak++
            if (thought) {
              // A fresh, self-contained thinking block per think call: push the text, then
              // seal it (thinkingReset) so the next thought / the reply opens a new block.
              send({ delta: '', done: false, thinking: thought })
              send({ delta: '', done: false, thinkingReset: true })
            }
            const assistantTurn = (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block
            history.push({ role: 'assistant', content: assistantTurn })
            if (thinkStreak > MAX_THINK_STREAK) {
              // It ignored the nudge and kept deliberating without acting — stop the loop and
              // let the closing turn force an answer rather than think to the turn ceiling.
              send({ delta: '', done: false, status: 'Wrapping up' })
              break
            }
            history.push({
              role: 'user',
              content:
                thinkStreak === MAX_THINK_STREAK
                  ? `${goalReminder}You have recorded your reasoning ${thinkStreak} times in a row without acting. Stop calling "think" and take a concrete step now: call a tool that actually does something (write_file, edit_file, run_command, a browser_* action, a search…) or give your final answer if the work is already done.`
                  : `${thought ? 'Reasoning recorded.' : 'Noted.'} ${goalReminder}Now act on it — call the tool that carries out your decided next step, or give your final answer if the request is fully done. Only call "think" again when you reach a genuinely new decision to reason through.`
            })
            continue
          }
          // A real (non-think) tool call — the deliberation streak is broken.
          thinkStreak = 0
          // A complete tool call arrived (not cut off mid-stream), so the truncation-
          // recovery streak resets: its cap counts only CONSECUTIVE cut-offs with no
          // successful call between them, letting a big project truncate a few times and
          // still finish while a perpetually-truncating file is still bounded.
          truncationContinues = 0
          // The model is acting, not prematurely stopping, so the plan-completion streak
          // resets too — the cap counts only CONSECUTIVE silent stops with pending plan
          // items, so a long multi-stage build that pauses, is nudged, then makes progress
          // never exhausts the cap early (RC-1).
          planIncompleteNudges = 0
          // NB: codeProseNudges is NOT reset here (RC-5). It must be grounded in a real
          // write (the `if (sideEffect)` block below), not any tool call — otherwise a
          // read_file / list_dir / update_plan launders the code-as-prose counter, which is
          // exactly how the e2e run gamed its way to a false "complete" while narrating
          // styles.css / app.js as prose and never saving them.

          // Live progress: an agentic run can legally run for dozens of steps, so the
          // status line carries the step number and elapsed minutes — the user always
          // sees how far along (and how long) the run is, instead of an endless
          // unlabeled spinner.
          const elapsedMin = Math.round((Date.now() - runStartedAt) / 60_000)
          const stepLabel = agentic ? ` — step ${turn + 1} · ${elapsedMin} min` : ''
          send({ delta: `\n${call.block}\n`, done: false, status: `Running ${toolName}${stepLabel}` })

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

          // Windowed oscillation guard: catches the NON-consecutive ping-pong the check
          // above misses (A,B,A,B,A…), where the same call keeps returning and keeps
          // returning the same result. Only fires when the CURRENT call is the offender
          // (so we don't nag right as the model finally does something different). First
          // trip → one strong nudge to break the pattern, tools still live; a second trip
          // → stop the loop rather than burn the budget spinning.
          recentSigs.push(callSig)
          if (recentSigs.length > OSCILLATION_WINDOW) recentSigs.shift()
          const osc = detectOscillation(recentSigs, {
            window: OSCILLATION_WINDOW,
            maxRepeatsInWindow: OSCILLATION_MAX
          })
          if (osc && osc.sig === callSig) {
            if (oscillationNudges === 0) {
              oscillationNudges++
              recentSigs.length = 0 // clean slate so the nudge gets a fair chance
              send({ delta: '', done: false, status: 'Breaking a repeat loop' })
              const assistantTurn = (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block
              history.push({ role: 'assistant', content: assistantTurn })
              history.push({
                role: 'user',
                content: `${goalReminder}You have issued the same "${toolName}" call ${osc.count} times and gotten the same result each time — this is a loop that is not advancing the task. Stop repeating it. Take a DIFFERENT concrete action toward the goal: write or edit a file, run the build, or give your final answer if the work is done. Do not issue that same call again.`
              })
              continue
            }
            send({ delta: toolResultBlock(toolName, `Stopped: "${toolName}" kept repeating (${osc.count}× in the last ${OSCILLATION_WINDOW} calls) without progress.`), done: false })
            break
          }

          // Permission gate: side-effecting tools in Cowork may need the user's OK,
          // unless already granted "always" for this run.
          const sideEffect = call.name ? lookupTool(call.name)?.sideEffect : undefined

          // Plan-mode gate (#8): in Cowork with plan mode on, the agent researches
          // read-only and drafts a plan (update_plan); the FIRST time it reaches for a
          // write/exec tool we stop and ask the user to approve the plan. Approve →
          // proceed; "Keep planning" → feed the revise request back and loop with tools
          // live, re-gating next time. When the plan is approved on THIS call, we skip the
          // per-call permission prompt for it (below) so the user isn't asked twice in a row
          // about the same action; later side-effecting calls still follow the permission tier.
          let planJustApproved = false
          if (planActive && !planApproved && sideEffect) {
            send({ delta: '', done: false, status: 'Plan ready — waiting for your approval' })
            const decision = await requestApproval(toolName, sideEffect, approvalDetail(call), true)
            if (controller.signal.aborted) return
            if (decision === 'deny') {
              const revise =
                'The user reviewed the plan and wants changes before anything is written or run. Revise the plan with update_plan to reflect what they want, and do not call a write/edit/delete/exec tool until they approve.'
              send({ delta: toolResultBlock(toolName, revise), done: false })
              const assistantTurn = (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block
              history.push({ role: 'assistant', content: assistantTurn })
              history.push({ role: 'user', content: `${revise}\n\n${goalReminder}` })
              continue
            }
            planApproved = true
            planJustApproved = true
          }

          // Approval gate. In the agentic modes (Cowork / Research) the permission tier
          // decides (ask / autoApprove / bypass) — and Research runs rooted at the user's
          // HOME folder with the browser armed, so gating side effects there matters even
          // more than in a scoped Cowork folder. In Chat there is no tier, but the browser's
          // click/type act on real pages — and on the user's own logins under system-chrome —
          // so those two are always confirmed before they run. Read-only browser tools have
          // no sideEffect and never prompt; "allow always" still skips repeats within the run.
          const needsApproval =
            !planJustApproved &&
            !(sideEffect && grantedAlways.has(sideEffect)) &&
            (agentic
              ? requiresApproval(permissionMode, sideEffect)
              : sideEffect === 'exec' && BROWSER_EXEC_TOOLS.has(toolName))

          let result: string
          if (needsApproval) {
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
                : await runTool(call, {
                    ...gate,
                    signal: controller.signal,
                    onPreview,
                    onPlan,
                    onCommand,
                    onFileSnapshot,
                    delegate,
                    askUser,
                    preToolUse,
                    postToolUse,
                    getBrowser,
                    renderDocument,
                    emitToolImages,
                    rasterizeDocument,
                    onStatus,
                    emitMedia,
                    onEditorEvent,
                    runFfmpeg,
                    probeMedia,
                    transcribeAudio,
                    resolveCredentialEnv,
                    redactSecrets,
                    saveCredential: workspaceDir ? (input) => saveCredential(workspaceDir, input) : undefined,
                    listCredentialMeta: workspaceDir ? () => listCredentialMeta(workspaceDir) : undefined,
                    deleteCredential: workspaceDir ? (site) => deleteCredential(workspaceDir, site) : undefined
                  })
          } else {
            result = await runTool(call, {
                    ...gate,
                    signal: controller.signal,
                    onPreview,
                    onPlan,
                    onCommand,
                    onFileSnapshot,
                    delegate,
                    askUser,
                    preToolUse,
                    postToolUse,
                    getBrowser,
                    renderDocument,
                    emitToolImages,
                    rasterizeDocument,
                    onStatus,
                    emitMedia,
                    onEditorEvent,
                    runFfmpeg,
                    probeMedia,
                    transcribeAudio,
                    resolveCredentialEnv,
                    redactSecrets,
                    saveCredential: workspaceDir ? (input) => saveCredential(workspaceDir, input) : undefined,
                    listCredentialMeta: workspaceDir ? () => listCredentialMeta(workspaceDir) : undefined,
                    deleteCredential: workspaceDir ? (site) => deleteCredential(workspaceDir, site) : undefined
                  })
          }
          if (controller.signal.aborted) return
          send({ delta: toolResultBlock(toolName, result), done: false })

          // present_plan approval (#8, Feature 1): the plan is now rendered in the preview
          // pane. While a plan gate is active and not yet approved, pause and ask the user to
          // approve it before any write/exec tool. Approve → unlock the build (planApproved);
          // "Keep planning" → feed the revise request back so the model re-presents a revised
          // plan, looping with tools still gated. This is the plan-DOCUMENT gate; the generic
          // first-side-effect gate above (L~2228) stays as a backstop if the model skips it.
          if (call.name === 'present_plan' && planActive && !planApproved) {
            send({ delta: '', done: false, status: 'Plan ready — waiting for your approval' })
            const decision = await requestApproval('present_plan', 'write', 'Review the plan', true)
            if (controller.signal.aborted) return
            const assistantTurn = (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block
            history.push({ role: 'assistant', content: assistantTurn })
            if (decision === 'deny') {
              const revise =
                'The user reviewed the plan and wants changes before anything is written or run. Revise the plan and call present_plan again with the updated plan, then wait for approval. Do not write, edit, delete, or run anything yet.'
              history.push({ role: 'user', content: `Tool result for present_plan:\n${result}\n\n${revise}\n\n${goalReminder}` })
              continue
            }
            planApproved = true
            const proceed =
              'The user approved the plan. Proceed now: execute it step by step, tracking progress with update_plan, and carry it through to a finished, verified result. Do not ask whether to continue.'
            history.push({ role: 'user', content: `Tool result for present_plan:\n${result}\n\n${proceed}\n\n${goalReminder}` })
            continue
          }

          // Journal meaningful actions (writes/edits/deletes/commands/code) so the next
          // turn knows they happened and doesn't repeat them (Cowork memory).
          if (mode === 'cowork' && workspaceDir) recordToolAction(workspaceDir, call, result)

          // Live plan reconciliation (display-level, EVERY tool round): mark file-target
          // steps done the moment their file actually exists on disk, and keep exactly
          // one step "in_progress" even when the model forgets update_plan for long
          // stretches. This is what makes the user's Progress panel track reality in
          // real time instead of freezing at the model's last call — zero model calls,
          // just local state plus a few sandboxed stat checks.
          if (agentic && latestPlan.length > 0) {
            const exists = workspaceDir
              ? (rel: string): boolean => {
                  const abs = resolveInWorkspace(workspaceDir, rel)
                  if (!abs) return false
                  try {
                    return (statSync(abs, { throwIfNoEntry: false })?.size ?? 0) > 0
                  } catch {
                    return false
                  }
                }
              : null
            const reconciled = reconcilePlanProgress(latestPlan, exists)
            if (reconciled) onPlan(reconciled)
          }
          // Keep the MODEL aware of the plan too — one compact line on every tool
          // result (skipped for update_plan itself, whose result already reports it),
          // so its next update_plan reflects what actually finished instead of a stale
          // full-list rewrite.
          let planDirective = ''
          if (agentic && latestPlan.length > 0 && call.name !== 'update_plan') {
            const doneCount = latestPlan.filter((t) => t.status === 'done').length
            const current = latestPlan.find((t) => t.status === 'in_progress')
            planDirective =
              `\n\nPlan progress: ${doneCount}/${latestPlan.length} done` +
              (current ? ` — "${current.title}" in progress.` : '.') +
              ` Keep the plan current: call update_plan whenever a step's status changes.`
          }

          // Progress guard: count real building (writes/edits/code/commands) vs. read-only
          // exploration. If the model keeps looking without ever building, escalate from
          // the gentle nudge to a hard directive that forbids more exploration.
          if (sideEffect) {
            buildsMade++
            exploreStreak = 0
            // Ground the code-as-prose reset in a REAL write/edit/delete/exec (RC-5), not
            // any tool call: a multi-file build that writes file 2, then narrates file 3 and
            // is nudged, should have a fresh budget — but a read-only call must NOT clear it,
            // or the model laundered the counter and narrated its way to a false finish.
            codeProseNudges = 0
          } else if (call.name && EXPLORE_TOOLS.has(call.name)) {
            exploreStreak++
          } else if (call.name === 'update_plan') {
            exploreStreak = 0 // planning is progress, not stalling
          }
          const stalling = mode === 'cowork' && buildsMade === 0 && exploreStreak >= MAX_EXPLORE_WITHOUT_BUILD
          const progressDirective = stalling
            ? `\n\nSTOP EXPLORING. You have inspected the folder ${exploreStreak} times and built NOTHING yet. The folder does not need more looking. Your VERY NEXT action MUST be to actually build: call update_plan with the concrete steps, then write_file to create the first real file. Do NOT call list_dir, read_file, search_code, or find_files again until files exist. Do not just say what you will do — do it now with a tool call.`
            : ''

          // Research-stall guard: catches the distinct-target research loop (web/browser/
          // file lookups across DIFFERENT targets) that every signature-keyed guard misses
          // because no single call repeats. A building action resets the streak; plan
          // updates and ask_user are neutral (so the model can't dodge by interleaving
          // them); any other action resets it too. See {@link researchStallVerdict}.
          if (sideEffect) {
            researchStreak = 0
          } else if (call.name && RESEARCH_TOOLS.has(call.name)) {
            researchStreak++
          } else if (call.name !== 'update_plan' && call.name !== 'ask_user') {
            researchStreak = 0
          }
          const researchVerdict = mode === 'cowork' ? researchStallVerdict(researchStreak) : 'ok'
          const researchDirective =
            researchVerdict !== 'ok'
              ? `\n\nSTOP RESEARCHING. You have run ${researchStreak} read-only research calls in a row (web searches, page opens, file lookups) without building anything. More searching will NOT complete the task. Your VERY NEXT action MUST build toward the goal: call write_file to create a real file (or edit_file / run_command). Do NOT open another page or run another search until you have produced files.`
              : ''

          // Record the round-trip for the model's next turn. The assistant turn is
          // its visible prose plus the call block; the tool result comes back as a
          // user turn (providers accept only user/assistant/system roles).
          const assistantTurn = (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block
          history.push({ role: 'assistant', content: assistantTurn })
          history.push({
            role: 'user',
            content: `Tool result for ${toolName}:\n${result}\n\n${goalReminder}Keep going until the request is fully done: call another tool if you still need to, or give your final answer once it is complete. Do not repeat an identical call. An empty or sparse result (e.g. a near-empty folder) is a starting point, not a reason to stop — build what was asked for.${planDirective}${progressDirective}${researchDirective}`
          })
          // A2b: if the tool rendered page images this round (render_document on a scanned
          // PDF), ride them on the tool-result user turn just pushed — the same turn, so
          // user/assistant alternation holds — and mirror them to the renderer as a `media`
          // chunk so the user sees the rendered pages inline. Drained once per round.
          if (pendingToolImages.length > 0) {
            const toolTurn = history[history.length - 1]
            toolTurn.images = [...(toolTurn.images ?? []), ...pendingToolImages]
            send({
              delta: '',
              done: false,
              media: pendingToolImages.map((img) => ({
                kind: 'image' as const,
                mediaType: img.mediaType,
                dataBase64: img.dataBase64,
                prompt: pendingToolImageCaption
              }))
            })
            pendingToolImages = []
            pendingToolImageCaption = undefined
          }
          // A distinct-target research loop that ignored the nudge and hit the hard cap:
          // stop the loop rather than let it research all the way to the turn ceiling. The
          // closing turn (below) makes the model answer with what it has.
          if (researchVerdict === 'stop') break
        }

        // Budget spent: force a closing turn with tools withheld so the reply never
        // ends mid-loop.
        agentTrace('finish', {
          reason: budgetReason,
          maxToolTurns,
          planDone: latestPlan.filter((t) => t.status === 'done').length,
          planTotal: latestPlan.length
        })
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
        // Track 2: tear down the run's browser (close the in-app window / kill the spawned
        // Chrome) if one was ever opened. Best-effort — teardown must never mask a reply error.
        // TS's control-flow analysis narrows `browserController` to `null` here (its only
        // synchronous assignment is the initializer; the real one happens inside the
        // getBrowser closure, which CFA doesn't propagate into this finally), so name the
        // real type explicitly before the optional-chained dispose.
        await (browserController as BrowserController | null)?.dispose().catch(() => {})
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
  // manageable even though the history it is folding is large: take the tail of the
  // joined text (the most recent, most relevant middle) if it runs long. 120k chars
  // ≈ 30k tokens — inside every model the loop targets, and large enough that a
  // compaction pass keeps real continuity instead of remembering only the tail.
  const TRANSCRIPT_CAP = 120_000
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
const SUBAGENT_EXCLUDED = new Set(['preview', 'update_plan', 'spawn_agent', 'spawn_agents', 'ask_user'])

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
  kind: 'gateway' | 'ollama'
} {
  const settings = getSettings()
  const kind = request.provider ?? settings.activeProvider
  const modelId = request.modelId ?? settings.modelId
  const provider =
    kind === settings.activeProvider
      ? providerFromSettings(settings)
      : createProvider(kind, kind === 'ollama' ? settings.ollama : settings.gateway)
  return { provider, modelId, messages: request.messages, kind }
}

/** Aborts every in-flight stream. Called on app shutdown. */
export function cancelAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
}

/**
 * Is this user prompt too small to deserve reasoning depth? A greeting, a "thanks",
 * a one-word ack — under ~4 short words with no code, URL, or newline. Measured
 * failure this fixes: "hii" on a slow reasoning endpoint burned 167 thinking tokens
 * and a minute of dead air BEFORE the first visible word, because the configured
 * reasoning effort was forwarded verbatim. A trivial prompt caps the effort at
 * 'low' — the one case where Myto overrides the user's effort choice, since the
 * choice was never about greetings. Anything longer or structured keeps the setting.
 */
function isTrivialPrompt(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 48) return false
  if (t.split(/\s+/).filter(Boolean).length > 4) return false
  return !/[\n`]|https?:|\.(com|org|net|dev|io)\b/i.test(t)
}
