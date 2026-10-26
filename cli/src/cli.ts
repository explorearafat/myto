import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { configHint, isConfigured, loadConfig, resolveWorkspace, saveUserConfig, userConfigPath, type MytoCliConfig } from './config'
import { runAgentLoop, runCliCommand, setThinking, thinkingOn, cliTools, estimateTokens, type PermissionDecision } from './loop'
import { createProvider } from '@app/main/providers'
import type { ChatMessage } from '@app/shared/types'
import * as ui from './ui'
import * as tui from './tui'
import * as input from './input'
import { renderMarkdown } from './md'
import { startSpinner } from './spinner'

declare const MYTO_CLI_VERSION: string
const VERSION = typeof MYTO_CLI_VERSION === 'string' ? MYTO_CLI_VERSION : '0.0.0'

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Slash commands available inside an interactive session (also the `/` palette). */
const SLASH: { name: string; desc: string }[] = [
  { name: '/model', desc: 'Pick the model — interactive menu' },
  { name: '/models', desc: 'List the models the endpoint serves' },
  { name: '/status', desc: 'Current setup: provider, model, session, tokens' },
  { name: '/config', desc: 'Show the current provider config' },
  { name: '/dir', desc: 'Switch the working folder: /dir <path>' },
  { name: '/permissions', desc: 'Toggle ask-before-acting / auto-approve' },
  { name: '/tools', desc: "List the agent's tools" },
  { name: '/init', desc: 'Survey the project and write a MYTO.md memory' },
  { name: '/memory', desc: 'Show the project memory (MYTO.md)' },
  { name: '/compact', desc: 'Summarize the session to free context' },
  { name: '/copy', desc: 'Copy the last answer to the clipboard' },
  { name: '/retry', desc: 'Re-run the last task' },
  { name: '/think', desc: 'Toggle the live thinking stream on/off' },
  { name: '/update', desc: 'Update Myto to the latest version' },
  { name: '/clear', desc: 'Start a fresh session' },
  { name: '/help', desc: 'Show this command list' },
  { name: '/quit', desc: 'Exit Myto' }
]

/** Colourful `myto help` — the static command reference shown outside a session. */
function helpText(): string {
  const p = ui.paint
  const row = (name: string, desc: string): string => `  ${p.cyan(name.padEnd(34))}${p.dim(desc)}`
  return [
    ui.banner(VERSION),
    p.bold('USAGE'),
    row('myto', 'Interactive session in the current folder'),
    row('myto "<task>"', 'One-shot task in the current folder'),
    row('myto --dir <path> "<task>"', 'One-shot task in a specific folder'),
    row('myto --auto "<task>"', 'One-shot without permission prompts'),
    row('myto config [options]', 'Save provider config to ~/.myto/config.json'),
    row('myto models', 'List models the configured endpoint serves'),
    row('myto update', 'Download/update Myto to the latest version'),
    row('myto --version', 'Print the CLI version'),
    '',
    p.bold('CONFIG') + p.dim('  (first run)'),
    p.dim('  myto config --base-url https://api.openai.com/v1 --api-key sk-… --model gpt-4o-mini'),
    p.dim('  myto config --ollama-url http://localhost:11434 --model llama3.1:8b'),
    p.dim('  Env: MYTO_BASE_URL · MYTO_API_KEY · MYTO_MODEL · MYTO_PROVIDER · MYTO_OLLAMA_URL · MYTO_DIR'),
    '',
    p.bold('IN A SESSION') + p.dim('  — type a task, / for commands, ! for shell'),
    SLASH.map((s) => `  ${p.cyan(s.name.padEnd(13))}${p.dim(s.desc)}`).join('\n'),
    '',
    p.dim('  Esc or Ctrl-C interrupts a running task · ↑ recalls earlier prompts.'),
    ''
  ].join('\n')
}

interface Args {
  oneShot?: string
  dir?: string
  auto?: boolean
  config?: Record<string, string | undefined>
  models?: boolean
  update?: boolean
  help?: boolean
  version?: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--version' || a === '-v') args.version = true
    else if (a === 'help') args.help = true
    else if (a === '--dir' || a === '-d') args.dir = argv[++i]
    else if (a === '--auto' || a === '--yolo') args.auto = true
    else if (a === 'models') args.models = true
    else if (a === 'update' || a === 'upgrade') args.update = true
    else if (a === 'config') {
      args.config = {}
      while (i + 1 < argv.length && argv[i + 1].startsWith('--')) {
        const flag = argv[++i]
        const key = flag.replace(/^--/, '')
        const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
        args.config[key] = value
      }
    } else rest.push(a)
  }
  if (rest.length > 0) args.oneShot = rest.join(' ')
  return args
}

function providerFromSettingsLike(cfg: MytoCliConfig) {
  return createProvider(cfg.activeProvider, cfg.activeProvider === 'ollama' ? cfg.ollama : cfg.gateway)
}

/** `myto update` — self-update by reinstalling the published package globally. */
function cmdUpdate(): Promise<number> {
  const p = ui.paint
  process.stdout.write(p.dim('Updating ') + p.cyan('mytocode') + p.dim(' to the latest version…\n'))
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve) => {
    const child = spawn(npm, ['install', '-g', 'mytocode@latest'], { stdio: 'inherit' })
    child.on('error', (err) => {
      process.stderr.write(
        p.red(`Update failed: ${msg(err)}\n`) + p.dim('Run it yourself: npm install -g mytocode@latest\n')
      )
      resolve(1)
    })
    child.on('close', (code) => {
      if (code === 0) {
        process.stdout.write(
          p.green(`${ui.sym.check} Updated. `) + p.dim('Run ') + p.cyan('myto --version') + p.dim(' to confirm.\n')
        )
        resolve(0)
      } else {
        process.stderr.write(p.red(`Update exited with code ${code ?? 1}.\n`))
        resolve(code ?? 1)
      }
    })
  })
}

async function cmdModels(): Promise<number> {
  const provider = providerFromSettingsLike(loadConfig())
  const list = await provider.listModels()
  if (!list.ok) {
    process.stderr.write(ui.paint.red(`Could not list models: ${list.error ?? 'unknown error'}\n`))
    return 1
  }
  if (list.models.length === 0) {
    process.stdout.write(ui.paint.dim('The endpoint serves no models (or lists none).\n'))
    return 0
  }
  for (const m of list.models) {
    process.stdout.write(`  ${ui.paint.cyan(m.id)}${m.name !== m.id ? ui.paint.dim(`  (${m.name})`) : ''}\n`)
  }
  return 0
}

function printConfig(cfg: MytoCliConfig): void {
  const p = ui.paint
  process.stdout.write(`  ${p.dim('provider')}  ${p.cyan(cfg.activeProvider)}\n`)
  if (cfg.activeProvider === 'gateway') {
    process.stdout.write(`  ${p.dim('base-url')}  ${cfg.gateway.baseUrl || p.red('(not set)')}\n`)
    process.stdout.write(`  ${p.dim('api-key ')}  ${cfg.gateway.apiKey ? '••••' + cfg.gateway.apiKey.slice(-4) : p.red('(not set)')}\n`)
  } else {
    process.stdout.write(`  ${p.dim('ollama  ')}  ${cfg.ollama.baseUrl}\n`)
  }
  process.stdout.write(`  ${p.dim('model   ')}  ${cfg.modelId ? p.cyan(cfg.modelId) : p.red('(not set)')}\n`)
}

async function cmdConfig(patch: Record<string, string | undefined>): Promise<number> {
  const saved = saveUserConfig({
    baseUrl: patch['base-url'],
    apiKey: patch['api-key'],
    model: patch.model,
    provider: patch.provider === 'gateway' || patch.provider === 'ollama' ? patch.provider : undefined,
    ollamaUrl: patch['ollama-url']
  })
  process.stdout.write(ui.paint.green(`${ui.sym.check} Saved `) + ui.paint.dim(userConfigPath()) + '\n')
  printConfig(saved)
  return 0
}

function notConfiguredMessage(cfg: MytoCliConfig): string {
  return (
    ui.paint.red('Myto is not configured yet.\n\n') +
    ui.paint.dim(configHint(cfg)) +
    '\n\n' +
    ui.paint.dim('Or set env vars: MYTO_BASE_URL, MYTO_API_KEY, MYTO_MODEL.\n')
  )
}

/** One-shot run (`myto "<task>"`). Returns the process exit code. */
async function runOnce(task: string, dir?: string, auto?: boolean): Promise<number> {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) {
    process.stderr.write(notConfiguredMessage(cfg))
    return 1
  }
  const result = await runAgentLoop({
    provider: providerFromSettingsLike(cfg),
    modelId: cfg.modelId,
    workspaceDir: resolveWorkspace(dir),
    task,
    spinnerHint: 'esc to interrupt',
    onPermission: auto === true && ui.isTty ? undefined : permissionGate()
  })
  process.stdout.write('\n')
  return result.finalText.startsWith('Error:') || result.finalText.startsWith('Stopped:') ? 1 : 0
}

/**
 * The permission gate the REPL/one-shot wire into the loop: an interactive menu
 * before every side-effecting tool (write / edit / delete / shell / code).
 * Non-interactive runs never hang: stdin-less contexts auto-approve upstream.
 */
function permissionGate(): (req: { displayName: string; target: string; kind: 'write' | 'exec' }) => Promise<PermissionDecision> {
  return async (req) => {
    const what = req.target ? `${req.displayName} ${req.target}` : req.displayName
    const choice = await ui.select<PermissionDecision>(
      `Myto wants to ${req.kind === 'exec' ? 'run' : 'change'} ${what}`,
      [
        { label: 'Yes', hint: 'allow once', value: 'allow' },
        { label: "Yes, don't ask again this session", value: 'allow-session' },
        { label: 'No', hint: 'tell Myto to try another way', value: 'deny' }
      ]
    )
    return choice ?? 'deny'
  }
}

/** Watch stdin while a run is in flight: Esc (or Ctrl-C) aborts it. Returns a stop fn. */
function watchInterrupt(controller: AbortController, paused: { value: boolean }): () => void {
  const stdin = process.stdin
  if (!ui.isTty || !stdin.isTTY || typeof stdin.setRawMode !== 'function') return () => {}
  const onData = (b: Buffer): void => {
    if (paused.value) return
    const s = b.toString('utf8')
    if (s === '\x1b' || s === '\x03') controller.abort(new Error('interrupted by user'))
  }
  stdin.resume()
  try {
    stdin.setRawMode(true)
  } catch {
    return () => {}
  }
  stdin.on('data', onData)
  return () => {
    stdin.removeListener('data', onData)
    try {
      stdin.setRawMode(false)
    } catch {
      /* ignore */
    }
    stdin.pause()
  }
}

async function repl(dir?: string): Promise<number> {
  let cfg = loadConfig()
  if (!isConfigured(cfg)) {
    process.stderr.write(notConfiguredMessage(cfg))
    return 1
  }
  let workspace = resolveWorkspace(dir)
  let lastAnswer = ''
  let lastTask = ''
  let session: ChatMessage[] = []
  let sessionSummary = ''
  let permMode: 'ask' | 'auto' = 'ask'
  const promptHistory: string[] = []
  const p = ui.paint

  const SUGGESTIONS = [
    'Explain this codebase',
    'Build a dashboard from a spec file',
    'Add tests and run them',
    '/init to write a project memory (MYTO.md)'
  ]

  const hintLine = (): string =>
    `${workspace}  ·  ${cfg.modelId || 'no model'}  ·  ${permMode === 'ask' ? 'asks before acting' : 'auto-approve'}  ·  /help for commands`

  const showWelcome = (): void => {
    process.stdout.write(
      tui.welcome(
        {
          version: VERSION,
          provider: cfg.activeProvider === 'ollama' ? 'Ollama (local)' : 'OpenAI-compatible',
          providerUrl: cfg.activeProvider === 'ollama' ? cfg.ollama.baseUrl : cfg.gateway.baseUrl,
          model: cfg.modelId,
          ready: isConfigured(cfg),
          workspace
        },
        SUGGESTIONS
      )
    )
  }
  showWelcome()

  /** One agent run with interrupt watching + the session permission policy. */
  const runTask = async (t: string, opts?: { fresh?: boolean; quietHeader?: boolean }): Promise<void> => {
    lastTask = t
    const history = opts?.fresh ? [] : session
    const controller = new AbortController()
    const paused = { value: false }
    const stopWatch = watchInterrupt(controller, paused)
    try {
      const res = await runAgentLoop({
        provider: providerFromSettingsLike(cfg),
        modelId: cfg.modelId,
        workspaceDir: workspace,
        task: t,
        history,
        systemExtra: sessionSummary ? `Earlier session summary (from /compact):\n${sessionSummary}` : undefined,
        spinnerHint: 'esc to interrupt',
        onPermission:
          permMode === 'auto' || !process.stdin.isTTY
            ? undefined
            : async (req) => {
                paused.value = true // let the menu own the terminal
                const decision = await permissionGate()(req)
                paused.value = false
                return decision
              }
      })
      session = res.history
      lastAnswer = res.finalText
    } catch (err) {
      process.stderr.write(p.red(`Run failed: ${msg(err)}\n`))
    } finally {
      stopWatch()
    }
  }

  const pickModel = async (): Promise<void> => {
    process.stdout.write(p.dim('  fetching models…\n'))
    const list = await providerFromSettingsLike(cfg).listModels()
    if (!list.ok || list.models.length === 0) {
      process.stdout.write(p.red(`  could not list models${list.ok ? '' : ': ' + (list.error ?? '')}\n`))
      return
    }
    const choice = await ui.select(
      'Select a model',
      list.models.map((m) => ({ label: m.id, hint: m.name !== m.id ? m.name : undefined, value: m.id }))
    )
    if (!choice) return
    cfg = saveUserConfig({ model: choice })
    process.stdout.write(p.green(`${ui.sym.check} model → `) + p.cyan(choice) + '\n')
  }

  /** /compact — fold the session into a summary so the context starts light. */
  const compactSession = async (): Promise<void> => {
    if (session.length === 0) {
      process.stdout.write(p.dim('  nothing to compact yet\n'))
      return
    }
    const spin = startSpinner('Compacting session', '')
    try {
      const digest = session
        .filter((m) => m.role !== 'system')
        .map((m) => `${m.role}: ${m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content}`)
        .join('\n\n')
      const provider = providerFromSettingsLike(cfg)
      const summary = await provider.getCompletion(cfg.modelId, [
        {
          role: 'system',
          content: 'Summarize this coding-agent session concisely: the tasks asked, the work done, key files touched and decisions made. Under 250 words.'
        },
        { role: 'user', content: digest }
      ])
      session = []
      sessionSummary = summary
      process.stdout.write(p.green(`${ui.sym.check} session compacted `) + p.dim('— a summary now rides the system prompt\n'))
    } catch (err) {
      process.stdout.write(p.red(`  compact failed: ${msg(err)}\n`))
    } finally {
      spin.stop()
    }
  }

  const memoryPath = (): string => join(workspace, 'MYTO.md')

  const showStatus = (): void => {
    const pnt = ui.paint
    const userTurns = session.filter((m) => m.role === 'user' && !m.content.startsWith('The user DECLINED')).length
    const rows: [string, string][] = [
      ['version', VERSION],
      ['provider', cfg.activeProvider === 'ollama' ? `ollama  ${cfg.ollama.baseUrl}` : `gateway  ${cfg.gateway.baseUrl || '(not set)'}`],
      ['model', cfg.modelId || '(not set)'],
      ['workspace', workspace],
      ['permissions', permMode === 'ask' ? 'ask before acting' : 'auto-approve (yolo)'],
      ['thinking', thinkingOn() ? 'on' : 'off'],
      ['session', `${userTurns} task(s) · ~${estimateTokens(session)} tokens${sessionSummary ? ' · compacted' : ''}`]
    ]
    process.stdout.write('\n' + rows.map(([k, v]) => `  ${pnt.gray(k.padEnd(12))}${pnt.cyan(v)}`).join('\n') + '\n\n')
  }

  const showTools = (): void => {
    const pnt = ui.paint
    process.stdout.write('\n')
    for (const t of cliTools()) {
      const tag = t.sideEffect === 'write' ? pnt.green('write') : t.sideEffect === 'exec' ? pnt.amber('exec') : pnt.gray('read')
      const short = t.description.split(/[.\n]/)[0]
      process.stdout.write(`  ${pnt.cyan((t.name ?? '').padEnd(14))}${tag}  ${pnt.dim(short)}\n`)
    }
    process.stdout.write('\n')
  }

  const handleSlash = async (cmd: string, arg: string): Promise<boolean> => {
    switch (cmd) {
      case '':
      case 'commands': {
        const choice = await ui.select(
          'Slash commands',
          SLASH.map((s) => ({ label: s.name, hint: s.desc, value: s.name }))
        )
        if (choice) return handleSlash(choice.slice(1), '')
        return false
      }
      case 'quit':
      case 'exit':
        process.stdout.write(p.dim('  bye ') + p.magenta(ui.sym.spark) + '\n')
        return true
      case 'help':
        process.stdout.write(SLASH.map((s) => `  ${p.cyan(s.name.padEnd(13))}${p.dim(s.desc)}`).join('\n') + '\n')
        return false
      case 'clear':
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
        session = []
        sessionSummary = ''
        showWelcome()
        return false
      case 'status':
        showStatus()
        return false
      case 'tools':
        showTools()
        return false
      case 'permissions': {
        permMode = permMode === 'ask' ? 'auto' : 'ask'
        process.stdout.write(
          permMode === 'auto'
            ? p.amber(`${ui.sym.check} auto-approve `) + p.dim('— side effects run without asking (Ctrl-C still interrupts)\n')
            : p.green(`${ui.sym.check} ask before acting `) + p.dim('— writes and shell runs prompt first\n')
        )
        return false
      }
      case 'init':
        await runTask(
          `Survey this project (${workspace}) and write a MYTO.md memory file at its root. Cover in brief: what the project is, the folder layout that matters, the build/test/run commands, and the conventions a coding agent should follow when editing here. Keep it under 60 lines. Create or overwrite MYTO.md.`,
          { fresh: true }
        )
        return false
      case 'memory': {
        const mp = memoryPath()
        if (!existsSync(mp)) {
          process.stdout.write(p.dim('  no MYTO.md yet — run ') + p.cyan('/init') + p.dim(' to let Myto write one\n'))
          return false
        }
        process.stdout.write('\n' + renderMarkdown(readFileSync(mp, 'utf8')) + '\n')
        return false
      }
      case 'compact':
        await compactSession()
        return false
      case 'models':
        await cmdModels()
        return false
      case 'config':
        printConfig(cfg)
        return false
      case 'model':
        await pickModel()
        return false
      case 'dir':
        if (!arg) {
          process.stdout.write(`  ${p.gray(workspace)}\n`)
        } else {
          workspace = resolveWorkspace(arg)
          process.stdout.write(p.green(`${ui.sym.check} folder → `) + p.gray(workspace) + '\n')
        }
        return false
      case 'copy': {
        if (!lastAnswer.trim()) {
          process.stdout.write(p.dim('  nothing to copy yet\n'))
          return false
        }
        const ok = await ui.copyToClipboard(lastAnswer)
        process.stdout.write(ok ? p.green(`${ui.sym.check} copied the last answer\n`) : p.red('  no clipboard tool found\n'))
        return false
      }
      case 'retry':
        if (!lastTask) process.stdout.write(p.dim('  no previous task\n'))
        else await runTask(lastTask)
        return false
      case 'update':
        await cmdUpdate()
        return false
      case 'think':
        setThinking(!thinkingOn())
        process.stdout.write(
          thinkingOn() ? p.green(`${ui.sym.check} thinking stream on\n`) : p.dim('  thinking stream off\n')
        )
        return false
      default:
        process.stdout.write(p.red(`  unknown command /${cmd}`) + p.dim(' — type / for the menu\n'))
        return false
    }
  }

  for (;;) {
    const raw = await input.readTask(SLASH, { history: promptHistory, hint: hintLine() })
    if (raw === null) {
      await handleSlash('quit', '')
      break
    }
    const line = raw.trim()
    if (!line) continue
    promptHistory.push(line)
    if (line.startsWith('!')) {
      // Shell escape: run the command directly, print its output.
      const cmdText = line.slice(1).trim()
      if (!cmdText) continue
      process.stdout.write(p.amber(`$ ${cmdText}\n`))
      const outText = await runCliCommand(cmdText, workspace)
      process.stdout.write(p.dim(outText.trim() || '(no output)') + '\n')
      continue
    }
    if (line.startsWith('/')) {
      const parts = line.slice(1).split(/\s+/)
      if (await handleSlash(parts[0] || '', parts.slice(1).join(' '))) break
      continue
    }
    await runTask(line)
  }
  return 0
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (args.help) {
    process.stdout.write(helpText() + '\n')
    return 0
  }
  if (args.config) return cmdConfig(args.config)
  if (args.models) return cmdModels()
  if (args.update) return cmdUpdate()

  // Abort in-flight streams on Ctrl-C (second Ctrl-C kills hard).
  let interrupted = 0
  process.on('SIGINT', () => {
    interrupted++
    if (interrupted >= 2) process.exit(130)
    process.stderr.write(ui.paint.dim('\n(again to force quit)\n'))
  })

  if (args.oneShot) return runOnce(args.oneShot, args.dir, args.auto)
  return repl(args.dir)
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(ui.paint.red(`myto: ${msg(err)}\n`))
    process.exit(1)
  })
