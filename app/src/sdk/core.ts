import type {
  ChatMessage,
  PermissionMode,
  ReasoningEffort,
  ToolDecision,
  ToolProposal,
  WorkMode,
  WorkflowEvent,
  WorkflowRunRequest
} from '../shared/types'

/**
 * The embeddable core of Sylor's agent SDK: everything needed to drive the
 * workflow engine from another program, with no Electron, no IPC, no window and
 * no GUI assumptions. Pure and fully injectable — the engine, the path setters
 * and the id source all arrive as {@link SdkDeps}, so this whole file is
 * unit-testable with fakes. The real wiring lives in `./index`.
 *
 * The engine speaks in a push stream of {@link WorkflowEvent}s and blocks on tool
 * approvals; embedders want a pull stream they can `for await` over and a plain
 * async function for the simple case. Bridging those two shapes — without
 * deadlocking on the approval handshake — is what this module is for.
 */

/** The engine functions the SDK drives (`../main/workflow/engine`). */
export interface SdkEngine {
  runWorkflow: (
    request: WorkflowRunRequest,
    emit: (event: WorkflowEvent) => void,
    onTerminal: (data: string) => void
  ) => Promise<void>
  resolveToolDecision: (runId: string, toolId: string, decision: ToolDecision) => void
  cancelWorkflow: (runId: string) => void
}

/**
 * Process-wide environment seams. Sylor's main modules resolve their storage from
 * Electron by default; an embedded run injects the same paths up front instead,
 * exactly as the GUI's main process and the headless CLI do at startup.
 */
export interface SdkEnvironment {
  setUserDataDir: (dir: string) => void
  setDbPath: (path: string) => void
  setRoot: (dir: string) => void
  setMcpRoot: (dir: string) => void
  /** Release the sqlite handle so a host process can exit promptly. */
  closeDb: () => void
}

/** Everything {@link createSylor} needs, with the paths already resolved. */
export interface SdkDeps {
  engine: SdkEngine
  env: SdkEnvironment
  /** Fresh run id (correlates events and cancellation). */
  newRunId: () => string
  /** Workspace root every run is pinned to. */
  root: string
  /** Per-user data directory (settings, memory, plugins). */
  userDataDir: string
  /** Sqlite file, usually `<userDataDir>/sylor.db`. */
  dbPath: string
}

/** A proposal awaiting a verdict, handed to {@link CanUseTool}. */
export interface ToolRequest {
  runId: string
  proposal: ToolProposal
  /**
   * True when the active permission mode already approved it — the engine is NOT
   * waiting, and the callback is not consulted. Present so a host can log it.
   */
  auto: boolean
  /** The subagent that asked, or undefined for the lead. */
  agentId?: string
}

/**
 * A host's approval policy. Called only for proposals the engine did not
 * pre-approve; may be async (prompt a user, check a policy service). Anything
 * that throws is treated as `reject` — a broken policy must never approve.
 */
export type CanUseTool = (request: ToolRequest) => ToolDecision | Promise<ToolDecision>

/** Per-run knobs. Any of these may also be set once as SDK-wide defaults. */
export interface RunOptions {
  permissionMode?: PermissionMode
  mode?: WorkMode
  effort?: ReasoningEffort
  planFirst?: boolean
  projectId?: string | null
  canUseTool?: CanUseTool
  /** Live command output, as the integrated terminal would receive it. */
  onTerminal?: (data: string) => void
  /** Cancels the run when aborted (same effect as breaking out of `stream`). */
  signal?: AbortSignal
}

/** SDK-wide defaults; every field is overridable per run. */
export type SylorOptions = RunOptions

/** The outcome of one completed run. */
export interface RunResult {
  runId: string
  /** False when the run emitted an `error` event. */
  ok: boolean
  /** The lead's answer: every lead `delta`, concatenated. */
  text: string
  /** The first error message, when `ok` is false. */
  error?: string
  /** Every event, in order — the full record for logging or replay. */
  events: WorkflowEvent[]
}

/** A multi-turn conversation: the same engine, with history carried for you. */
export interface SylorSession {
  /** The running transcript. Mutated as turns complete; safe to read or seed. */
  readonly messages: ChatMessage[]
  /** Send one turn and await its result. */
  send: (prompt: string, options?: RunOptions) => Promise<RunResult>
  /** Send one turn and consume its events as they happen. */
  stream: (prompt: string, options?: RunOptions) => AsyncGenerator<WorkflowEvent, void, void>
  /** Forget the transcript (keeps the SDK's settings and root). */
  reset: () => void
}

/** The embeddable handle returned by {@link createSylor}. */
export interface Sylor {
  /** The workspace root every run is pinned to. */
  readonly root: string
  /** Run one turn to completion. */
  run: (input: string | ChatMessage[], options?: RunOptions) => Promise<RunResult>
  /** Run one turn, yielding each event as it is emitted. */
  stream: (
    input: string | ChatMessage[],
    options?: RunOptions
  ) => AsyncGenerator<WorkflowEvent, void, void>
  /** Open a multi-turn session over the same engine. */
  session: (history?: ChatMessage[]) => SylorSession
  /** Cancel a specific in-flight run (no-op if unknown). */
  cancel: (runId: string) => void
  /** Release the sqlite handle. Call when the host is done. */
  close: () => void
}

/**
 * The verdict for a proposal when the host supplied no {@link CanUseTool}. With
 * nobody to ask, the safe default is to REJECT — the model is told and adapts —
 * unless the embedder explicitly chose hands-free `autonomous`. This is the same
 * posture the headless CLI takes.
 */
export function defaultDecision(permissionMode: PermissionMode): ToolDecision {
  return permissionMode === 'autonomous' ? 'approve' : 'reject'
}

/**
 * The text destined for the caller's answer: lead deltas only. A subagent's
 * deltas carry an `agentId` and are progress, not the answer, so they never
 * pollute {@link RunResult.text}.
 */
export function answerText(event: WorkflowEvent): string | null {
  return event.type === 'delta' && event.agentId === undefined ? event.text : null
}

/**
 * A push→pull bridge: producers `push` and `close`, one consumer `for await`s.
 * Unbounded and lossless — the engine emits synchronously and must never be made
 * to wait on a slow consumer, so buffered events are held rather than dropped.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private closed = false

  /** Queue a value, handing it straight to a waiting consumer when there is one. */
  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiting
    if (waiter) {
      this.waiting = null
      waiter({ value, done: false })
      return
    }
    this.buffer.push(value)
  }

  /** No more values. A consumer drains what is buffered, then finishes. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const waiter = this.waiting
    if (waiter) {
      this.waiting = null
      waiter({ value: undefined as never, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      // Length, not a shift()-is-undefined check: a queued `undefined` is a value.
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve
      })
      if (next.done === true) return
      yield next.value
    }
  }
}

/** Normalize the two accepted inputs into the engine's message list. */
function toMessages(input: string | ChatMessage[]): ChatMessage[] {
  return typeof input === 'string' ? [{ role: 'user', content: input }] : [...input]
}

/**
 * Drain an event stream into a {@link RunResult}. The engine never throws, so a
 * failure shows up as the first `error` event — which is what decides `ok`, since
 * "the run finished" and "the run succeeded" are not the same thing.
 */
export async function collect(
  events: AsyncIterable<WorkflowEvent>
): Promise<RunResult> {
  const seen: WorkflowEvent[] = []
  let text = ''
  let error: string | undefined
  let runId = ''

  for await (const event of events) {
    seen.push(event)
    runId = event.runId
    const chunk = answerText(event)
    if (chunk !== null) text += chunk
    if (event.type === 'error' && error === undefined) error = event.message
  }

  return { runId, ok: error === undefined, text, error, events: seen }
}

/**
 * Build an embeddable Sylor. Injects the storage paths and workspace root ONCE,
 * up front, in the same order the GUI's main process uses at startup — the engine
 * reads settings, memory and the DB lazily, so nothing has been resolved yet.
 */
export function createSylor(options: SylorOptions, deps: SdkDeps): Sylor {
  deps.env.setUserDataDir(deps.userDataDir)
  deps.env.setDbPath(deps.dbPath)
  deps.env.setRoot(deps.root)
  deps.env.setMcpRoot(deps.root)

  const stream = (
    input: string | ChatMessage[],
    perRun: RunOptions = {}
  ): AsyncGenerator<WorkflowEvent, void, void> => {
    const settings = { ...options, ...perRun }
    const permissionMode = settings.permissionMode ?? 'ask'
    const runId = deps.newRunId()
    const queue = new AsyncQueue<WorkflowEvent>()

    const request: WorkflowRunRequest = {
      runId,
      messages: toMessages(input),
      permissionMode,
      projectId: settings.projectId ?? null,
      effort: settings.effort,
      planFirst: settings.planFirst ?? false,
      mode: settings.mode,
      // Pin the run to our root so a host that changes directories mid-run — or
      // shares one engine across sessions — cannot move this run's file access.
      root: deps.root
    }

    const emit = (event: WorkflowEvent): void => {
      queue.push(event)
      if (event.type !== 'tool-request' || event.auto) return

      // The approval handshake MUST be deferred. The engine emits `tool-request`
      // and only then registers the pending decision (it awaits immediately after
      // emitting), so resolving synchronously here would find no pending entry and
      // the run would hang forever. A microtask runs once that synchronous
      // emit→await has unwound, by which point the entry exists.
      const proposalId = event.proposal.id
      queueMicrotask(() => {
        void (async (): Promise<void> => {
          let decision: ToolDecision
          try {
            decision = settings.canUseTool
              ? await settings.canUseTool({
                  runId,
                  proposal: event.proposal,
                  auto: event.auto,
                  agentId: event.agentId
                })
              : defaultDecision(permissionMode)
          } catch {
            // A policy that throws must never be read as consent.
            decision = 'reject'
          }
          deps.engine.resolveToolDecision(runId, proposalId, decision)
        })()
      })
    }

    const onTerminal = (data: string): void => settings.onTerminal?.(data)

    // Start immediately — the engine pushes into the queue whether or not the
    // consumer has begun iterating, so no event can be missed between the two.
    const finished = deps.engine
      .runWorkflow(request, emit, onTerminal)
      .catch((error: unknown) => {
        // runWorkflow reports failures as events and does not throw; this is pure
        // belt-and-braces so a host still sees a terminal event either way.
        queue.push({
          type: 'error',
          runId,
          message: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => queue.close())

    const abort = (): void => deps.engine.cancelWorkflow(runId)
    settings.signal?.addEventListener('abort', abort, { once: true })
    if (settings.signal?.aborted === true) abort()

    return (async function* consume(): AsyncGenerator<WorkflowEvent, void, void> {
      try {
        for await (const event of queue) yield event
      } finally {
        // Reached on an early `break`/`return` too: cancel the run rather than
        // leaving it burning tokens with nobody listening, then wait for it to
        // unwind so the host's `close()` cannot race an in-flight DB write.
        settings.signal?.removeEventListener('abort', abort)
        abort()
        await finished
      }
    })()
  }

  const run = async (
    input: string | ChatMessage[],
    perRun: RunOptions = {}
  ): Promise<RunResult> => collect(stream(input, perRun))

  const session = (history: ChatMessage[] = []): SylorSession => {
    const messages: ChatMessage[] = [...history]

    /** Append the turn, run it, then record whatever the assistant actually said. */
    const turn = (
      prompt: string,
      perRun: RunOptions | undefined
    ): AsyncGenerator<WorkflowEvent, void, void> => {
      messages.push({ role: 'user', content: prompt })
      const inner = stream([...messages], perRun)
      return (async function* record(): AsyncGenerator<WorkflowEvent, void, void> {
        let text = ''
        for await (const event of inner) {
          const chunk = answerText(event)
          if (chunk !== null) text += chunk
          yield event
        }
        // Only a reply that exists is remembered — an interrupted or errored turn
        // must not leave an empty assistant message poisoning the next prompt.
        if (text.trim()) messages.push({ role: 'assistant', content: text })
      })()
    }

    return {
      messages,
      send: (prompt, perRun) => collect(turn(prompt, perRun)),
      stream: (prompt, perRun) => turn(prompt, perRun),
      reset: () => void messages.splice(0, messages.length)
    }
  }

  return {
    root: deps.root,
    run,
    stream,
    session,
    cancel: (runId) => deps.engine.cancelWorkflow(runId),
    close: () => {
      try {
        deps.env.closeDb()
      } catch {
        /* best-effort: nothing to close, or already closed */
      }
    }
  }
}
