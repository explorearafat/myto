import { spawn } from 'node:child_process'
import { configHint, isConfigured, loadConfig, resolveWorkspace, saveUserConfig, userConfigPath, type MytoCliConfig } from './config'
import { runAgentLoop, setThinking, thinkingOn } from './loop'
import { createProvider } from '@app/main/providers'
import * as ui from './ui'
import * as tui from './tui'
import * as input from './input'

declare const MYTO_CLI_VERSION: string
const VERSION = typeof MYTO_CLI_VERSION === 'string' ? MYTO_CLI_VERSION : '0.0.0'

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Slash commands available inside an interactive session (also the `/` palette). */
const SLASH: { name: string; desc: string }[] = [
  { name: '/model', desc: 'Pick the model — interactive menu' },
  { name: '/models', desc: 'List the models the endpoint serves' },
  { name: '/config', desc: 'Show the current provider config' },
  { name: '/dir', desc: 'Switch the working folder: /dir <path>' },
  { name: '/copy', desc: 'Copy the last answer to the clipboard' },
  { name: '/retry', desc: 'Re-run the last task' },
  { name: '/think', desc: 'Toggle the live thinking stream on/off' },
  { name: '/update', desc: 'Update Myto to the latest version' },
  { name: '/clear', desc: 'Clear the screen' },
  { name: '/help', desc: 'Show this command list' },
  { name: '/quit', desc: 'Exit Myto' }
]

/** Colourful `myto help` — the static command reference shown outside a session. */
function helpText(): string {
  const p = ui.paint
  const row = (name: string, desc: string): string => `  ${p.cyan(name.padEnd(30))}${p.dim(desc)}`
  return [
    ui.banner(VERSION),
    p.bold('USAGE'),
    row('myto', 'Interactive session in the current folder'),
    row('myto "<task>"', 'One-shot task in the current folder'),
    row('myto --dir <path> "<task>"', 'One-shot task in a specific folder'),
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
    p.bold('IN A SESSION') + p.dim('  — type a task, or / for the command menu'),
    SLASH.map((s) => `  ${p.cyan(s.name.padEnd(10))}${p.dim(s.desc)}`).join('\n'),
    ''
  ].join('\n')
}

interface Args {
  oneShot?: string
  dir?: string
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
async function runOnce(task: string, dir?: string): Promise<number> {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) {
    process.stderr.write(notConfiguredMessage(cfg))
    return 1
  }
  const result = await runAgentLoop({
    provider: providerFromSettingsLike(cfg),
    modelId: cfg.modelId,
    workspaceDir: resolveWorkspace(dir),
    task
  })
  process.stdout.write('\n')
  return result.finalText.startsWith('Error:') ? 1 : 0
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
  const p = ui.paint

  const SUGGESTIONS = [
    'Explain this codebase',
    'Build a dashboard from a spec file',
    'Add tests and run them',
    'Find opportunities to refactor'
  ]
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

  const runTask = async (t: string): Promise<void> => {
    lastTask = t
    try {
      const res = await runAgentLoop({
        provider: providerFromSettingsLike(cfg),
        modelId: cfg.modelId,
        workspaceDir: workspace,
        task: t
      })
      lastAnswer = res.finalText
    } catch (err) {
      process.stderr.write(p.red(`Run failed: ${msg(err)}\n`))
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
        process.stdout.write(SLASH.map((s) => `  ${p.cyan(s.name.padEnd(10))}${p.dim(s.desc)}`).join('\n') + '\n')
        return false
      case 'clear':
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
        showWelcome()
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
    const raw = await input.readTask(SLASH)
    if (raw === null) {
      await handleSlash('quit', '')
      break
    }
    const line = raw.trim()
    if (!line) continue
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

  if (args.oneShot) return runOnce(args.oneShot, args.dir)
  return repl(args.dir)
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(ui.paint.red(`myto: ${msg(err)}\n`))
    process.exit(1)
  })
