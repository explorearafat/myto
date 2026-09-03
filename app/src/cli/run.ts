import type { ToolDecision, WorkflowEvent, WorkflowRunRequest } from '../shared/types'
import type { CliOptions } from './args'
import { deltaForStdout, formatEventForStderr, headlessDecision } from './format'

/**
 * The engine + environment seams the headless runner needs. Injected as a plain
 * object so {@link runHeadless} can be unit-tested with fakes — no Electron, no
 * real model call, no DB, no filesystem. The entry ({@link ../cli/index}) wires
 * the real engine functions and the Electron-free path setters.
 */
export interface HeadlessDeps {
  /** The engine's run entry (`runWorkflow`). Resolves when the run completes. */
  runWorkflow: (
    request: WorkflowRunRequest,
    emit: (event: WorkflowEvent) => void,
    onTerminal: (data: string) => void
  ) => Promise<void>
  /** Resolve a pending tool approval (`resolveToolDecision`). */
  resolveToolDecision: (runId: string, toolId: string, decision: ToolDecision) => void
  /** Inject the userData dir before the engine reads settings/memory. */
  setUserDataDir: (dir: string) => void
  /** Inject the sqlite path before the engine touches the DB. */
  setDbPath: (path: string) => void
  /** Point the context manager at the workspace root. */
  setRoot: (dir: string) => void
  /** Point the MCP manager at the workspace root. */
  setMcpRoot: (dir: string) => void
  /** Sink for the streamed answer (stdout). */
  writeStdout: (text: string) => void
  /** Sink for progress / tool activity (stderr). */
  writeStderr: (text: string) => void
  /** Fresh run id (correlates events + any cancellation). */
  newRunId: () => string
  /** Resolved userData directory. */
  userDataDir: string
  /** Resolved sqlite path (usually `<userData>/sylor.db`). */
  dbPath: string
  /** Resolved workspace root. */
  root: string
}

/**
 * Drive one headless workflow run to completion and return a process exit code:
 * 0 on success, 1 if the run reported an `error` event. Streams the assistant's
 * answer to stdout and progress/tool activity to stderr — or, with `--json`, emits
 * every {@link WorkflowEvent} as JSONL to stdout for scripting. With no human to
 * approve, any proposal the engine flags for approval is decided per the headless
 * policy (see {@link headlessDecision}). Never throws: the engine reports failures
 * as events, and this mirrors them into the exit code.
 */
export async function runHeadless(options: CliOptions, deps: HeadlessDeps): Promise<number> {
  // Inject the Electron-free paths BEFORE the engine reads settings/DB/root — the
  // same order the GUI's main process uses at startup. Cheap and lazy: the DB file
  // isn't opened until something queries it.
  deps.setUserDataDir(deps.userDataDir)
  deps.setDbPath(deps.dbPath)
  deps.setRoot(deps.root)
  deps.setMcpRoot(deps.root)

  const runId = deps.newRunId()
  const request: WorkflowRunRequest = {
    runId,
    messages: [{ role: 'user', content: options.prompt }],
    permissionMode: options.permissionMode,
    projectId: null,
    effort: options.effort,
    planFirst: false,
    mode: options.mode
  }

  let sawError = false

  const emit = (event: WorkflowEvent): void => {
    if (event.type === 'error') sawError = true

    if (options.json) {
      deps.writeStdout(`${JSON.stringify(event)}\n`)
    } else {
      const out = deltaForStdout(event)
      if (out !== null) deps.writeStdout(out)
      const line = formatEventForStderr(event)
      if (line !== null) deps.writeStderr(`${line}\n`)
    }

    // With no human to approve, decide any non-auto proposal ourselves. This MUST
    // be deferred: the engine emits `tool-request` BEFORE it registers the pending
    // decision (it awaits immediately after emitting), so resolving synchronously
    // here would find no pending entry and the run would hang. A microtask runs
    // only once the engine's synchronous emit→await has unwound — by which point
    // the pending entry exists — so the decision lands correctly.
    const verdict = headlessDecision(event, options.permissionMode)
    if (verdict) {
      if (!options.json) {
        deps.writeStderr(
          verdict.decision === 'reject'
            ? '  ↳ skipped (needs approval; re-run with --permission-mode autonomous to allow)\n'
            : '  ↳ approved (autonomous)\n'
        )
      }
      queueMicrotask(() => deps.resolveToolDecision(runId, verdict.toolId, verdict.decision))
    }
  }

  const onTerminal = (): void => {}
  await deps.runWorkflow(request, emit, onTerminal)

  // Terminate the streamed answer with a newline so the shell prompt returns
  // cleanly and a piped consumer gets a well-formed final line. Skipped in JSON
  // mode, where each event is already its own line.
  if (!options.json) deps.writeStdout('\n')
  return sawError ? 1 : 0
}
