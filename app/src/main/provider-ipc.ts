import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  ApprovalDecision,
  ApprovalRequest,
  AskQuestion,
  QuestionRequest,
  ChatMessage,
  ChatMode,
  CommandRun,
  CompletionRequest,
  CompletionResult,
  FileSnapshot,
  GatewayConfig,
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
import { toErrorMessage, httpStatusOf, rateLimitRetryDelay } from './providers/http'
import { getSettings, saveSettings } from './settings'
import {
  createStatusStripper,
  reasoningCaption,
  COWORK_SYSTEM_PROMPT,
  coworkBrowserPrompt,
  FILE_PROTOCOL_SYSTEM_PROMPT,
  IDENTITY_SYSTEM_PROMPT,
  outputStylePrompt,
  PLAN_MODE_SYSTEM_PROMPT,
  STATUS_SYSTEM_PROMPT
} from './status'
import { availableTools, lookupTool, runTool, toolSchemas, toolsSystemPrompt, type ToolGate } from './tools/registry'
import { ensureMytoDir, readJournal, recordGoal, recordToolAction } from './cowork-memory'
import {
  looksLikeUnsavedCode,
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
  MAX_ANNOUNCED_ACTION,
  MAX_FALSE_LIMIT_DEFERRAL,
  MAX_EMPTY_START
} from './cowork-guards'
import { detectRuntimesCached, summarizeRuntimes } from './cowork-runtimes'
import { browserToolsEnabled } from './cowork-browser'
import { createBrowserController, type BrowserController } from './cowork-browser-runtime'
import { renderDocumentPdf } from './cowork-docgen-runtime'
import type { BrowserSession } from './cowork-browser-cdp'
import { readUserMemory } from './user-memory'
import { materializeAttachments, type MaterializedAttachment } from './cowork-attachments'
import { insertFileSnapshot } from './db/snapshots'
import { approvalDetail, requiresApproval } from './tools/approvals'
import { createToolCallParser, toolCallBlock, toolResultBlock, type ToolCall } from './tools/toolParser'
import { executeArgv, formatRunResult, resolveShell } from './tools/runCode'
import { homedir } from 'node:os'
import { resolveResearchAgent, buildAgentSystemPrompt, agentIdentityLine } from './agents/persona'

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
 * dozens of round-trips, and the user's explicit ask was to remove any per-run cap and
 * "give infinite steps to build a project". So there is NO fixed ceiling: the loop runs
 * until the model decides it is done (a no-tool-call turn that clears the stall guards)
 * or a stall guard ends it. Three things keep an unbounded loop safe: in-loop context
 * compaction (below) stops the message history growing without limit as turns pile up;
 * the stall guards ({@link MAX_REPEAT_CALLS} / {@link MAX_EXPLORE_WITHOUT_BUILD} /
 * {@link detectOscillation} / {@link researchStallVerdict}) end a loop that stops making
 * progress; and the user can Stop the run at any time. If a guard does break the loop,
 * the final turn still withholds tools so the reply never ends mid-loop.
 */
const MAX_TOOL_TURNS_COWORK = Number.POSITIVE_INFINITY

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

/** Read-only "look at the project" tools — churning on these without building is the
 *  classic weak-model stall (see the progress guard in the Cowork loop). */
const EXPLORE_TOOLS = new Set(['list_dir', 'read_file', 'search_code', 'find_files'])
/** After this many explorations with nothing built yet, force a "stop looking, build now". */
const MAX_EXPLORE_WITHOUT_BUILD = 2

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
        thinking?: string
        thinkingReset?: boolean
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

        // Cowork project memory (.myto/journal.md): read what earlier turns already
        // did in this folder so this turn continues instead of repeating. Best-effort.
        let coworkMemory = ''
        if (mode === 'cowork' && workspaceDir) {
          ensureMytoDir(workspaceDir)
          coworkMemory = readJournal(workspaceDir)
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
        // Global (user-level) memory: cross-project facts/preferences the user saved,
        // injected in EVERY mode (chat and cowork) so they always apply. Best-effort.
        const userMemory = readUserMemory()
        // Attachments → working folder (Cowork): the user's uploaded files live under
        // userData/attachments/… which the sandboxed fs tools can't reach. Copy THIS
        // turn's into <workspace>/uploads/ so the agent opens them directly by path
        // instead of failing to find them, and note them in the system head below.
        // Best-effort and Cowork-only; never blocks the reply.
        let attachedFiles: MaterializedAttachment[] = []
        if (mode === 'cowork' && workspaceDir && request.sessionId) {
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
        // Plan mode (#8): a Cowork-only gate. When on, the agent must research + draft a
        // plan and win the user's approval before the first write/exec tool. Injects the
        // plan directive into baseSystem and arms the one-time plan gate in the loop below.
        const planActive = mode === 'cowork' && settings.cowork.planMode

        // Research persona: the chosen professional agent (one of 300+ in the catalog),
        // resolved from the persisted id with a fallback to the default generalist, and
        // composed into a full system prompt on demand. In Research this REPLACES the
        // generic Cowork prompt — buildAgentSystemPrompt already appends the folderless,
        // full-tool working contract (RESEARCH_WORKING_PROMPT). Null outside Research.
        const researchAgent = research ? resolveResearchAgent(settings.researchAgentId) : null
        if (researchAgent) {
          send({ delta: '', done: false, status: `${researchAgent.name} · ${researchAgent.categoryName}` })
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
        ): Promise<{ visible: string; call: ToolCall | null; error?: string; truncated?: boolean }> => {
          // Per-turn abort, chained to the outer user-cancel controller: aborting
          // `iter` ends just this generation (e.g. once a tool call is complete)
          // without tearing down the whole reply.
          const iter = new AbortController()
          const onOuterAbort = (): void => iter.abort()
          if (controller.signal.aborted) iter.abort()
          else controller.signal.addEventListener('abort', onOuterAbort, { once: true })

          const stripper = createStatusStripper()
          // Native mode reads the structured tool call from the chunk stream, so the
          // text-protocol fence parser stays off; otherwise it watches the prose.
          const toolParser = parseTools && !useNativeTools ? createToolCallParser() : null
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

          // Close this turn's thinking phase (if one is open): send a final snapshot
          // then a reset so the renderer's block stops blinking and the NEXT turn's
          // reasoning opens a fresh block instead of overwriting this one. Idempotent.
          const closeThinking = (): void => {
            if (!reasoningText || thinkingClosed) return
            thinkingClosed = true
            send({ delta: '', done: false, thinking: reasoningText })
            send({ delta: '', done: false, thinkingReset: true })
          }

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
                return
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
          }): void => {
            if (pendingCall) return // call already found — ignore the tail
            // Native function-calling (#15): the gateway assembled a structured tool call.
            // Synthesize the SAME ```myto:tool block the text protocol produces so history,
            // the transcript card, and the loop stay format-agnostic, then end the turn
            // exactly like the text path does on a complete fence.
            if (parseTools && chunk.toolCall) {
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
              const name = chunk.toolCall.name
              pendingCall = {
                block: toolCallBlock(name, parseErr ? {} : input),
                name,
                input: parseErr ? {} : input,
                error: parseErr
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
            // `done` is intentionally not handled here — the loop sends it.
          }

          // Bounded retry around the generation stream. A busy free-tier endpoint
          // answers with 429 (rate limit) or a transient 5xx *at the headers stage* —
          // before a single token is emitted — so re-issuing the identical request after
          // a short wait is safe and usually succeeds. We retry ONLY while this turn has
          // emitted nothing (so a partial reply can never be duplicated), honour any
          // Retry-After, and keep the user informed with a visible countdown. Exhausted
          // or non-retryable → fall through to the humanized error (toErrorMessage spells
          // out a 429 in plain language and points at Rewrite / another model).
          for (let attempt = 0; ; attempt++) {
            try {
              await provider.streamCompletion(modelId, turnHistory, onProviderChunk, iter.signal, {
                reasoningEffort: settings.reasoningEffort,
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
                return { visible, call: pendingCall } // ended early for a tool
              }
              // Only a pristine turn may be retried; a mid-stream failure keeps its
              // partial output and surfaces the error rather than replaying tokens.
              const pristine = visible === '' && reasoningText === '' && !contentStarted
              const delay = pristine ? rateLimitRetryDelay(err, attempt) : null
              if (delay === null) {
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
          return { visible, call: pendingCall, truncated }
        }

        // Base system prompts: <status> narration + the file-card protocol. Applied
        // only here, on the interactive stream — the non-streaming getCompletion
        // path (auto-titles) never receives them.
        const baseSystem: ChatMessage[] = [
          // Identity FIRST, in every mode: pins the assistant to "Myto" so the
          // underlying gateway/model never leaks a foreign name (it was answering
          // "Kiro", then "Claude"). See IDENTITY_SYSTEM_PROMPT.
          { role: 'system', content: IDENTITY_SYSTEM_PROMPT },
          { role: 'system', content: STATUS_SYSTEM_PROMPT },
          { role: 'system', content: FILE_PROTOCOL_SYSTEM_PROMPT },
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
          // Cowork turns the assistant into a goal-driven agent over the folder; Research
          // swaps in the chosen professional agent's persona, which carries its own
          // folderless full-tool working contract (so no generic Cowork prompt on top).
          ...(mode === 'cowork'
            ? [{ role: 'system' as const, content: COWORK_SYSTEM_PROMPT }]
            : research && researchAgent
              ? [{ role: 'system' as const, content: buildAgentSystemPrompt(researchAgent) }]
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
          ...(planActive ? [{ role: 'system' as const, content: PLAN_MODE_SYSTEM_PROMPT }] : []),
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
        // Persona anchor: in Research, reassert the chosen agent's identity at the top of
        // every mid-run nudge so a long autonomous run can't drift out of character.
        const agentPrefix = researchAgent ? `${agentIdentityLine(researchAgent)}\n` : ''
        const goalLine = goal
          ? `Remember, the user's request is: "${goal.length > 500 ? `${goal.slice(0, 500)}…` : goal}"\n\n`
          : ''
        const goalReminder = agentPrefix + goalLine
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

        // Verify gate state (#16): how many times the verify command has run this reply,
        // and whether it has passed (so a later natural-done doesn't re-run it needlessly).
        let verifyRounds = 0
        let verifyPassed = false

        // Plan-mode gate state (#8): whether the user has approved the drafted plan this
        // reply. Until then the FIRST side-effecting tool is held for plan approval.
        let planApproved = false

        for (let turn = 0; turn < maxToolTurns; turn++) {
          // Keep the running history inside the context window on long tasks: once it
          // grows past the threshold, fold the older middle into a short summary so the
          // loop can continue instead of eventually overflowing the model. Agentic modes
          // only (Cowork/Research) — a plain-chat tool loop is short and never reaches this.
          if (agentic && historyChars(history) > COMPACT_OVER_CHARS) {
            await compactMiddle(history, baseLen, provider, modelId, controller.signal)
            if (controller.signal.aborted) return
          }

          const { visible, call, error, truncated } = await runTurn(history, true)
          if (controller.signal.aborted) return
          if (error) {
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
              send({ delta: notice, done: false })
              send({ delta: '', done: true })
              return
            }
            // Code-as-prose guard: in Cowork the deliverable is files on disk, but a
            // weaker model often prints a file's contents in a fence and calls it done
            // without ever invoking write_file — so nothing is saved. If this reply built
            // nothing yet and ends on a substantial code block, nudge it once to actually
            // write the file (with an explicit escape hatch if it only meant to explain),
            // then loop with tools still live.
            if (
              mode === 'cowork' &&
              workspaceDir &&
              buildsMade === 0 &&
              codeProseNudges === 0 &&
              looksLikeUnsavedCode(visible)
            ) {
              codeProseNudges++
              send({ delta: '', done: false, status: 'Saving the code to a file' })
              history.push({ role: 'assistant', content: visible })
              history.push({
                role: 'user',
                content: `${goalReminder}You wrote code in your reply but never saved it — it only exists in this chat, so the user cannot run or keep it. In Cowork you MUST create files with the write_file tool. Call write_file now with the correct path and the FULL contents of the file(s) you just showed. If you genuinely only meant to illustrate something and no file should be created, say so explicitly instead.`
              })
              continue
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
                content: `${goalReminder}There is NO per-reply tool limit and no cap that forces you to stop — you can keep calling tools until the work is genuinely finished. Do not defer the work to a "next turn" and do not claim a limit or quota was reached; that is not true here. Take the next concrete action NOW: emit the tool call (write_file / edit_file / run_command …) that moves the project forward, with the full file contents. If the project is genuinely, fully complete, say so explicitly and stop.`
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
                    renderDocument
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
                    renderDocument
                  })
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
            content: `Tool result for ${toolName}:\n${result}\n\n${goalReminder}Keep going until the request is fully done: call another tool if you still need to, or give your final answer once it is complete. Do not repeat an identical call. An empty or sparse result (e.g. a near-empty folder) is a starting point, not a reason to stop — build what was asked for.${progressDirective}${researchDirective}`
          })
          // A distinct-target research loop that ignored the nudge and hit the hard cap:
          // stop the loop rather than let it research all the way to the turn ceiling. The
          // closing turn (below) makes the model answer with what it has.
          if (researchVerdict === 'stop') break
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
