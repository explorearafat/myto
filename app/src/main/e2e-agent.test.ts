/**
 * Step-5 end-to-end reliability harness for the agentic loop (Cowork).
 *
 * This drives the REAL `ProvidersStreamStart` loop in provider-ipc.ts against the
 * REAL gateway provider + REAL model + REAL filesystem tools — the only faithful way
 * to prove the "stops midway" fixes (RC-1 plan-completion gate, RC-2 truncation/stop
 * surfacing, RC-3 529 retry, utf8) actually make it finish a full multi-file build.
 *
 * It is GATED behind MYTO_E2E so the normal `vitest run` (and CI) skips it — it makes
 * live, paid model calls. Run it explicitly:
 *
 *   MYTO_E2E=1 MYTO_AGENT_LOG=1 npx vitest run src/main/e2e-agent.test.ts
 *
 * The API key is never read or printed by this file: it seeds a temp userData dir by
 * FILE-COPYING the user's real sylor-settings.json (the key rides along untouched),
 * then overrides only the non-secret cowork fields (workspace/permission/plan/verify).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TodoItem } from '../shared/types'

// --- electron mock: capture ipc handlers/listeners; stub windowing (never called here).
const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  listeners: new Map<string, (...a: unknown[]) => unknown>(),
  box: { userData: '' }
}))

vi.mock('electron', () => {
  class Stub {}
  return {
    app: {
      getPath: () => ipc.box.userData,
      getName: () => 'Myto',
      getVersion: () => '0.7.0',
      getAppPath: () => process.cwd(),
      isPackaged: false,
      on: () => {},
      whenReady: () => Promise.resolve(),
      quit: () => {}
    },
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => ipc.handlers.set(ch, fn),
      on: (ch: string, fn: (...a: unknown[]) => unknown) => ipc.listeners.set(ch, fn),
      removeHandler: (ch: string) => ipc.handlers.delete(ch)
    },
    BrowserWindow: Stub,
    Tray: Stub,
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
    session: { defaultSession: {}, fromPartition: () => ({}) },
    shell: { openExternal: () => Promise.resolve() },
    dialog: {},
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
    desktopCapturer: {},
    screen: {},
    net: {}
  }
})

// Imports that pull the electron-coupled graph resolve to the mock above.
import { IpcChannel } from '../shared/ipc'
import { registerProviderIpc } from './provider-ipc'
import { setUserDataDir, getSettings, saveSettings } from './settings'

const RUN_E2E = !!process.env.MYTO_E2E
const REAL_SETTINGS = join(process.env.APPDATA ?? '', 'myto', 'sylor-settings.json')
const HAVE_SETTINGS = existsSync(REAL_SETTINGS)

// The task from the brief's Step 5. The Cowork workspace already IS the e2e-output
// folder (seeded below), so the files go at the root of the working folder — saying
// "./e2e-output" again would make the model create a nested e2e-output/ subdir.
const PROMPT =
  'Build a small personal-finance dashboard web app in the current working folder with ' +
  'index.html, styles.css and app.js (dark/light theme toggle, transactions table, a chart). ' +
  'Create the files at the root of the working folder using the write_file tool — ' +
  'do not paste file contents into chat.'

// Where the agent builds. cwd under vitest is app/, so this is app/e2e-output.
const E2E_DIR = join(process.cwd(), 'e2e-output')
const EXPECTED_FILES = ['index.html', 'styles.css', 'app.js']

type Chunk = {
  delta?: string
  done?: boolean
  error?: string
  status?: string
  todos?: TodoItem[]
  approval?: { approvalId: string; toolName?: string }
  question?: { questionId: string; questions?: unknown[] }
}

interface RunResult {
  chunks: Chunk[]
  todos: TodoItem[] | null
  text: string
  errors: string[]
  sawDone: boolean
}

/**
 * Invoke the captured ProvidersStreamStart handler with a fake sender that records
 * every chunk, and auto-settles any approval/question the loop parks on (there should
 * be none under bypass + planMode:false, but this keeps a stray one from hanging the
 * headless run). Resolves when the handler's awaited loop sends its terminal done.
 */
async function runBuild(streamId: string): Promise<RunResult> {
  const handler = ipc.handlers.get(IpcChannel.ProvidersStreamStart)
  if (!handler) throw new Error('ProvidersStreamStart handler was not registered')

  const chunks: Chunk[] = []
  let todos: TodoItem[] | null = null
  let text = ''
  const errors: string[] = []
  let sawDone = false

  const sender = {
    isDestroyed: () => false,
    send: (_channel: string, chunk: Chunk) => {
      chunks.push(chunk)
      if (chunk.delta) text += chunk.delta
      if (chunk.todos) todos = chunk.todos
      if (chunk.error) errors.push(chunk.error)
      if (chunk.done) sawDone = true
      // Defensive auto-answer so a stray gate never parks the headless loop.
      if (chunk.approval) {
        const id = chunk.approval.approvalId
        setTimeout(() => ipc.listeners.get(IpcChannel.ProvidersApprovalDecision)?.(null, id, 'allow_always'), 0)
      }
      if (chunk.question) {
        const id = chunk.question.questionId
        const answers = (chunk.question.questions ?? []).map(() => 'Use sensible defaults and proceed.')
        setTimeout(() => ipc.listeners.get(IpcChannel.ProvidersQuestionAnswer)?.(null, id, answers), 0)
      }
    }
  }

  await (handler as (e: unknown, id: string, req: unknown) => Promise<void>)(
    { sender },
    streamId,
    { mode: 'cowork', messages: [{ role: 'user', content: PROMPT }] }
  )
  return { chunks, todos, text, errors, sawDone }
}

/**
 * A brand-new, never-before-used workspace for run `n`. Each run gets its OWN subdir so
 * the harness never has to delete a just-used folder: on Windows (especially under
 * OneDrive) `rmSync` of a freshly-written dir throws EPERM because a sync/AV/child-process
 * handle still lingers on it — which failed runs 2–3 in an earlier harness even though
 * run 1 built perfectly. A unique dir per run sidesteps the delete entirely; the whole
 * e2e-output tree is left for best-effort cleanup at process exit, once handles are gone.
 * The loop reads `settings.cowork.workspaceDir` fresh on every stream (provider-ipc.ts),
 * so pointing the workspace here per run is enough — see the caller.
 */
function freshWorkspace(n: number): string {
  const dir = join(E2E_DIR, `run-${n}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Assert the three files exist, are non-empty, and carry no U+FFFD replacement char. */
function assertFilesGood(dir: string): void {
  for (const name of EXPECTED_FILES) {
    const p = join(dir, name)
    expect(existsSync(p), `${name} should exist`).toBe(true)
    expect(statSync(p).size, `${name} should be non-empty`).toBeGreaterThan(0)
    const body = readFileSync(p, 'utf8')
    expect(body.includes('�'), `${name} should have no corrupted characters`).toBe(false)
  }
}

const RUN_TIMEOUT_MS = 15 * 60 * 1000

describe.skipIf(!RUN_E2E || !HAVE_SETTINGS)('agentic loop e2e — finishes a full multi-file build', () => {
  beforeAll(() => {
    // Seed a throwaway userData dir from the real settings file (key rides along,
    // never parsed or printed here), then override only the non-secret cowork knobs
    // so the headless run can't park on an approval and builds into e2e-output.
    const seedDir = mkdtempSync(join(tmpdir(), 'myto-e2e-userdata-'))
    copyFileSync(REAL_SETTINGS, join(seedDir, 'sylor-settings.json'))
    ipc.box.userData = seedDir
    setUserDataDir(seedDir)

    const s = getSettings()
    // workspaceDir is set per run (freshWorkspace) so each build gets its own clean dir.
    s.cowork.permissionMode = 'bypass' // never blocks on an approval prompt (no renderer)
    s.cowork.planMode = false // skip the plan-approval handshake; update_plan stays available
    s.cowork.verifyCommand = '' // no build command for a static site; keep the run deterministic
    s.tools.enabled = true
    saveSettings(s)

    registerProviderIpc()
  })

  // Three consecutive from-scratch builds must all finish fully (brief: prove reliability).
  for (const n of [1, 2, 3]) {
    it(
      `run ${n}/3 reaches all plan items done with non-empty, uncorrupted files`,
      async () => {
        const dir = freshWorkspace(n)
        // The loop reads settings.cowork.workspaceDir fresh per stream, so switching it
        // here (before runBuild) makes this run build into its own from-scratch folder.
        const s = getSettings()
        s.cowork.workspaceDir = dir
        saveSettings(s)
        const r = await runBuild(`e2e-run-${n}-${Date.now()}`)

        // Dump the full assistant transcript for ground-truth diagnosis of any failure
        // (which files were narrated vs written, where the run stopped). Written OUTSIDE
        // the workspace so freshWorkspace() on the next run doesn't wipe it.
        try {
          writeFileSync(join(process.cwd(), `e2e-transcript-run${n}.log`), r.text, 'utf8')
        } catch {
          /* diagnostic only — never fail the run on a transcript write */
        }

        // eslint-disable-next-line no-console
        console.log(
          `[e2e run ${n}] chunks=${r.chunks.length} done=${r.sawDone} ` +
            `plan=${r.todos ? r.todos.filter((t) => t.status === 'done').length + '/' + r.todos.length : 'none'} ` +
            `files=${EXPECTED_FILES.filter((f) => existsSync(join(dir, f))).length}/${EXPECTED_FILES.length} ` +
            `errors=${r.errors.length}`
        )

        expect(r.sawDone, 'the stream should reach a terminal done').toBe(true)
        expect(r.errors, `no error chunks, got: ${r.errors.join(' | ')}`).toHaveLength(0)

        expect(r.todos, 'the model should have published a plan (update_plan)').not.toBeNull()
        const plan = r.todos as TodoItem[]
        expect(plan.length, 'plan should have steps').toBeGreaterThan(0)
        const pending = plan.filter((t) => t.status !== 'done').map((t) => t.title)
        expect(pending, `all plan items should be done; still pending: ${pending.join(', ')}`).toHaveLength(0)

        assertFilesGood(dir)
      },
      RUN_TIMEOUT_MS
    )
  }
})

