import { createInterface } from 'node:readline'
import { configHint, isConfigured, loadConfig, resolveWorkspace, saveUserConfig, userConfigPath } from './config'
import { runAgentLoop, cliSettings } from './loop'
import { createProvider } from '@app/main/providers'

const HELP = `
${'Myto CLI'} — the Myto agent in your terminal.

USAGE
  myto                          Interactive session in the current folder
  myto "<task>"                 One-shot task in the current folder
  myto --dir <path> "<task>"    One-shot task in a specific folder
  myto config [options]         Save provider config to ~/.myto/config.json
  myto models                   List models the configured endpoint serves
  myto --version                Print the CLI version
  myto help                     This help

CONFIG (first run)
  myto config --base-url https://api.openai.com/v1 --api-key sk-… --model gpt-4o-mini
  myto config --base-url https://api.anthropic.com/v1 --api-key sk-ant-… --model claude-sonnet-4-5
  myto config --ollama-url http://localhost:11434 --model llama3.1:8b
  Or via environment: MYTO_BASE_URL, MYTO_API_KEY, MYTO_MODEL, MYTO_PROVIDER,
  MYTO_AUTH_SCHEMA, MYTO_AUTH_HEADER, MYTO_OLLAMA_URL, MYTO_DIR

BEHAVIOUR
  The agent works directly on your project folder: it can read, create, edit and
  search files, run shell commands, and fetch/search the web until your task is
  done. Config resolves from: environment > ~/.myto/config.json > the Myto
  desktop app's saved settings.
`.trim() + '\n'

declare const MYTO_CLI_VERSION: string
const VERSION = typeof MYTO_CLI_VERSION === 'string' ? MYTO_CLI_VERSION : '0.0.0'

interface Args {
  oneShot?: string
  dir?: string
  config?: Record<string, string | undefined>
  models?: boolean
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
    else if (a === 'config') {
      args.config = {}
      // Consume the config subcommand's flags.
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

async function cmdModels(): Promise<number> {
  const cfg = loadConfig()
  const provider = providerFromSettingsLike(cfg)
  const list = await provider.listModels()
  if (!list.ok) {
    process.stderr.write(`Could not list models: ${list.error ?? 'unknown error'}\n`)
    return 1
  }
  if (list.models.length === 0) {
    process.stdout.write('The endpoint serves no models (or lists none).\n')
    return 0
  }
  for (const m of list.models) process.stdout.write(`${m.id}${m.name !== m.id ? `  (${m.name})` : ''}\n`)
  return 0
}

function providerFromSettingsLike(cfg: ReturnType<typeof loadConfig>) {
  return createProvider(cfg.activeProvider, cfg.activeProvider === 'ollama' ? cfg.ollama : cfg.gateway)
}

async function cmdConfig(patch: Record<string, string | undefined>): Promise<number> {
  const saved = saveUserConfig({
    baseUrl: patch['base-url'],
    apiKey: patch['api-key'],
    model: patch.model,
    provider: patch.provider === 'gateway' || patch.provider === 'ollama' ? patch.provider : undefined,
    ollamaUrl: patch['ollama-url']
  })
  process.stdout.write(`Saved ${userConfigPath()}\n`)
  process.stdout.write(`  provider: ${saved.activeProvider}\n`)
  if (saved.activeProvider === 'gateway') {
    process.stdout.write(`  base-url: ${saved.gateway.baseUrl}\n`)
    process.stdout.write(`  api-key:  ${saved.gateway.apiKey ? '••••' + saved.gateway.apiKey.slice(-4) : '(not set)'}\n`)
  } else {
    process.stdout.write(`  ollama:   ${saved.ollama.baseUrl}\n`)
  }
  process.stdout.write(`  model:    ${saved.modelId || '(not set)'}\n`)
  return 0
}

/** One agent run (one-shot or one REPL turn). Returns the exit code. */
async function runOnce(task: string, dir?: string, extraSystem?: string): Promise<number> {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) {
    process.stderr.write(
      `Myto is not configured yet.\n\n${configHint(cfg)}\n\nOr set env vars: MYTO_BASE_URL, MYTO_API_KEY, MYTO_MODEL.\n`
    )
    return 1
  }
  const workspace = resolveWorkspace(dir)
  const provider = providerFromSettingsLike(cfg)
  const result = await runAgentLoop({
    provider,
    modelId: cfg.modelId,
    workspaceDir: workspace,
    task,
    systemExtra: extraSystem
  })
  process.stdout.write('\n')
  return result.finalText.startsWith('Error:') ? 1 : 0
}

async function repl(dir?: string): Promise<number> {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) {
    process.stderr.write(
      `Myto is not configured yet.\n\n${configHint(cfg)}\n\nOr set env vars: MYTO_BASE_URL, MYTO_API_KEY, MYTO_MODEL.\n`
    )
    return 1
  }
  const workspace = resolveWorkspace(dir)
  process.stdout.write(`Myto CLI — working folder ${workspace}\nType your task, or /quit to exit.\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  for (;;) {
    const line: string = await new Promise((resolve) => rl.question('\nyou › ', resolve))
    const t = line.trim()
    if (!t) continue
    if (t === '/quit' || t === '/exit') break
    if (t === '/help') {
      process.stdout.write('/quit  exit · /help  this help\n')
      continue
    }
    try {
      await runOnce(t, dir)
    } catch (err) {
      process.stderr.write(`Run failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  rl.close()
  return 0
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (args.help) {
    process.stdout.write(HELP + '\n')
    return 0
  }
  if (args.config) return cmdConfig(args.config)
  if (args.models) return cmdModels()

  // Abort in-flight streams on Ctrl-C (second Ctrl-C kills hard).
  let interrupted = 0
  process.on('SIGINT', () => {
    interrupted++
    if (interrupted >= 2) process.exit(130)
    process.stderr.write('\n(again to force quit)\n')
  })

  if (args.oneShot) return runOnce(args.oneShot, args.dir)
  return repl(args.dir)
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`myto: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
