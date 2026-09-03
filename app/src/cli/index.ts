import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runWorkflow, resolveToolDecision } from '../main/workflow/engine'
import { setUserDataDir } from '../main/settings'
import { setDbPath, closeDb } from '../main/db/db'
import { contextManager } from '../main/context/manager'
import { mcpManager } from '../main/mcp/manager'
import { parseCliArgs, USAGE } from './args'
import { resolveUserDataDir } from './paths'
import { runHeadless } from './run'

/**
 * Sylor's headless entry — the `sylor` bin. Boots the SAME workflow engine the
 * desktop app runs, but with no BrowserWindow and no IPC: it parses argv, injects
 * the Electron-free userData/DB/root paths (exactly as the GUI's main process does
 * at startup), drives one run of {@link runWorkflow}, and streams the answer to
 * stdout. Because it runs under plain `node` — never the Electron binary — it
 * physically cannot open a window; `require('electron')` yields a path string and
 * `app` is never dereferenced (the settings layer falls through to the injected
 * dir). This unlocks piping, scripting, and CI use of the engine.
 */

/** Read the whole prompt from stdin when it's piped (never blocks on a TTY). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8').trim()
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2))

  if (parsed.kind === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`sylor: ${parsed.message}\n\n${USAGE}\n`)
    process.exitCode = 2
    return
  }

  const options = parsed.options
  // No prompt on the command line → accept one piped on stdin (e.g. `cat q | sylor -p`).
  if (!options.prompt.trim()) {
    const piped = await readStdin()
    if (piped) options.prompt = piped
  }
  if (!options.prompt.trim()) {
    process.stderr.write(`sylor: no prompt given\n\n${USAGE}\n`)
    process.exitCode = 2
    return
  }

  const userDataDir = resolveUserDataDir(options.userDataDir)
  const root = options.root ?? process.cwd()
  const dbPath = join(userDataDir, 'sylor.db')

  try {
    process.exitCode = await runHeadless(options, {
      runWorkflow,
      resolveToolDecision,
      setUserDataDir,
      setDbPath,
      setRoot: (dir) => contextManager.setRoot(dir),
      setMcpRoot: (dir) => mcpManager.setProjectRoot(dir),
      writeStdout: (text) => void process.stdout.write(text),
      writeStderr: (text) => void process.stderr.write(text),
      newRunId: () => randomUUID(),
      userDataDir,
      dbPath,
      root
    })
  } finally {
    // Release the sqlite handle (if the run opened one) so the event loop drains
    // and the process exits promptly instead of hanging on an open connection.
    try {
      closeDb()
    } catch {
      /* best-effort: nothing to close, or already closed */
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sylor: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
