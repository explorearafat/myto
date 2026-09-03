import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runWorkflow, resolveToolDecision, cancelWorkflow } from '../main/workflow/engine'
import { setUserDataDir } from '../main/settings'
import { setDbPath, closeDb } from '../main/db/db'
import { contextManager } from '../main/context/manager'
import { mcpManager } from '../main/mcp/manager'
import { resolveUserDataDir } from '../cli/paths'
import { createSylor as createSylorCore, type RunOptions, type Sylor } from './core'

/**
 * Sylor's agent SDK — the desktop app's workflow engine as an embeddable library.
 *
 * Importing this module gives another program the SAME engine the GUI runs: the
 * project scan, the tool protocol, the permission gates, sub-agents, hooks, MCP,
 * memory and the diagnostics feed. There is no BrowserWindow and no IPC; the
 * Electron-resolved paths are injected instead, exactly as the headless CLI does,
 * so it runs under plain `node` and physically cannot open a window.
 *
 * ```ts
 * import { createSylor } from 'sylor/sdk'
 *
 * const sylor = createSylor({ root: process.cwd(), permissionMode: 'auto-edit' })
 * for await (const event of sylor.stream('Where is the tool protocol parsed?')) {
 *   if (event.type === 'delta') process.stdout.write(event.text)
 * }
 * sylor.close()
 * ```
 *
 * The default posture is deliberately timid: with no `canUseTool` policy and no
 * `permissionMode`, every proposal the engine does not pre-approve is REJECTED,
 * so an embedded run cannot write files or execute commands until the host says
 * so. Opt in per host, not by accident.
 */

/** Options for {@link createSylor}: the per-run knobs plus where things live. */
export interface CreateSylorOptions extends RunOptions {
  /** Workspace root the agent may read and write. Defaults to `process.cwd()`. */
  root?: string
  /**
   * Per-user data directory holding settings, memory and plugins. Defaults to the
   * installed app's own folder (or `$SYLOR_USER_DATA`), so an embedded run reads
   * whatever the user configured in the GUI. Point it elsewhere to sandbox a host.
   */
  userDataDir?: string
  /** Sqlite file. Defaults to `<userDataDir>/sylor.db`. */
  dbPath?: string
}

/**
 * Create an embeddable Sylor bound to one workspace root. Cheap: nothing is read
 * and no process is spawned until the first run. The returned handle is reusable
 * for many runs and sessions; call `close()` when the host is done so the sqlite
 * handle is released and the event loop can drain.
 */
export function createSylor(options: CreateSylorOptions = {}): Sylor {
  const { root, userDataDir, dbPath, ...runOptions } = options
  const resolvedUserData = resolveUserDataDir(userDataDir ?? null)
  return createSylorCore(runOptions, {
    engine: { runWorkflow, resolveToolDecision, cancelWorkflow },
    env: {
      setUserDataDir,
      setDbPath,
      setRoot: (dir) => contextManager.setRoot(dir),
      setMcpRoot: (dir) => mcpManager.setProjectRoot(dir),
      closeDb
    },
    newRunId: () => randomUUID(),
    root: root ?? process.cwd(),
    userDataDir: resolvedUserData,
    dbPath: dbPath ?? join(resolvedUserData, 'sylor.db')
  })
}

export {
  AsyncQueue,
  answerText,
  collect,
  defaultDecision,
  type CanUseTool,
  type RunOptions,
  type RunResult,
  type SdkDeps,
  type SdkEngine,
  type SdkEnvironment,
  type Sylor,
  type SylorOptions,
  type SylorSession,
  type ToolRequest
} from './core'

// The engine's own vocabulary, re-exported so an embedder needs no deep imports
// to type an event handler or an approval policy.
export type {
  ChatMessage,
  DiagnosticEntry,
  PermissionMode,
  ReasoningEffort,
  ToolDecision,
  ToolProposal,
  ToolResult,
  WorkMode,
  WorkflowEvent,
  WorkflowRunRequest
} from '../shared/types'
