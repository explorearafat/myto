import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { configHint, isConfigured, loadConfig, resolveWorkspace, saveUserConfig, userConfigPath, type MytoCliConfig } from './config'
import { runAgentLoop, runCliCommand, setThinking, thinkingOn, cliTools, estimateTokens, type PermissionDecision } from './loop'
import { createProvider, type Provider } from '@app/main/providers'
import type { ChatMessage } from '@app/shared/types'
import * as ui from './ui'
import * as tui from './tui'
import * as input from './input'
import { renderMarkdown } from './md'
import { startSpinner } from './spinner'
import { watchInterrupt } from './interrupt'
import { MAIN_MENU, authLine, numberMenu } from './menu'
import { chatSession } from './chat'
import { QUICK_ACTIONS, type QuickAction } from './actions'
import { listSkills, saveSkill, skillTemplate, type Skill } from './skills'
import { listPlugins, pluginTemplate, savePlugin, type PluginManifest } from './plugins'

declare const MYTO_CLI_VERSION: string
const VERSION = typeof MYTO_CLI_VERSION === 'string' ? MYTO_CLI_VERSION : '0.0.0'

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Slash commands available inside an interactive session (also the `/` palette). */
const SLASH: { name: string; desc: string }[] = [
  { name: '/menu', desc: 'Back to the main menu (Chat · Cowork · Skills…)' },
  { name: '/chat', desc: 'Switch to Chat mode — plain conversation, no tools' },
  { name: '/model', desc: 'Pick the model — interactive menu' },
  { name: '/models', desc: 'List the models the endpoint serves' },
  { name: '/status', desc: 'Current setup: provider, model, session, tokens' },
  { name: '/config', desc: 'Show the current provider config' },
  { name: '/connector', desc: 'Provider endpoints, keys and connection test' },
  { name: '/dir', desc: 'Switch the working folder: /dir <path>' },
  { name: '/permissions', desc: 'Toggle ask-before-acting / auto-approve' },
  { name: '/tools', desc: "List the agent's tools" },
  { name: '/skills', desc: 'Browse and run skills' },
  { name: '/command', desc: 'Quick actions and automation' },
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
    row('myto', 'Interactive session — main menu: Chat · Cowork · Skills…'),
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

/** The auth + workspace header shown under the banner, above the main menu. */
function authHeader(cfg: MytoCliConfig, workspace: string): string {
  const isOllama = cfg.activeProvider === 'ollama'
  return authLine({
    provider: isOllama ? 'ollama (local)' : 'gateway',
    url: isOllama ? cfg.ollama.baseUrl : cfg.gateway.baseUrl || '(no base URL)',
    keyMasked: !isOllama && cfg.gateway.apiKey ? '····' + cfg.gateway.apiKey.slice(-4) : undefined,
    model: cfg.modelId,
    workspace,
    ready: isConfigured(cfg)
  })
}

/** One menu-driven one-shot agent run in the workspace (skills, quick actions). */
async function runMenuTask(task: string, workspace: string, opts?: { systemExtra?: string }): Promise<void> {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) {
    process.stderr.write(notConfiguredMessage(cfg))
    return
  }
  try {
    await runAgentLoop({
      provider: providerFromSettingsLike(cfg),
      modelId: cfg.modelId,
      workspaceDir: workspace,
      task,
      systemExtra: opts?.systemExtra,
      spinnerHint: 'esc to interrupt',
      onPermission: ui.isTty ? permissionGate() : undefined
    })
  } catch (err) {
    process.stderr.write(ui.paint.red(`Run failed: ${msg(err)}\n`))
  }
}

/** Pick a model interactively from the live endpoint list and persist it. */
async function pickModelGlobal(): Promise<void> {
  const p = ui.paint
  if (!interactive()) {
    await cmdModels() // piped runs: list, don't silently re-pick
    return
  }
  const cfg = loadConfig()
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
  saveUserConfig({ model: choice })
  process.stdout.write(p.green(`${ui.sym.check} model → `) + p.cyan(choice) + '\n')
}

/** Read one line from the prompt box (for URLs, keys, names). Null = cancelled. */
async function askLine(placeholder: string, hint?: string): Promise<string | null> {
  const raw = await input.readTask([], { placeholder, hint })
  if (raw === null) return null
  const t = raw.trim()
  return t || null
}

/** True when the terminal can drive interactive select menus (raw keys + mouse). */
function interactive(): boolean {
  const stdin = process.stdin
  return ui.isTty && stdin.isTTY === true && typeof stdin.setRawMode === 'function'
}

/** Connector — provider endpoints: switch provider, set credentials, test. */
async function connectorMenu(): Promise<void> {
  const p = ui.paint
  if (!interactive()) {
    // Piped/CI runs can't drive the select menu: show the config and stop.
    printConfig(loadConfig())
    return
  }
  for (;;) {
    const cfg = loadConfig()
    printConfig(cfg)
    const pick = await ui.select('Connector — provider endpoints', [
      { label: 'Test connection', hint: `probe ${cfg.activeProvider} with ${cfg.modelId || 'no model'}`, value: 'test' },
      { label: 'Use OpenAI-compatible gateway', hint: 'hosted or self-hosted OpenAI-style API', value: 'gateway' },
      { label: 'Use Ollama (local)', hint: cfg.ollama.baseUrl, value: 'ollama' },
      { label: 'Set gateway base URL', value: 'url' },
      { label: 'Set gateway API key', hint: 'stored in ~/.myto/config.json, never printed', value: 'key' },
      { label: 'Set Ollama URL', value: 'ourl' },
      { label: 'Back', value: 'back' }
    ])
    if (!pick || pick === 'back') return
    if (pick === 'test') {
      if (!isConfigured(cfg)) {
        process.stdout.write(p.amber('  finish the configuration first — a test needs a model id\n'))
        continue
      }
      const spin = startSpinner('Testing connection', '')
      try {
        const r = await providerFromSettingsLike(cfg).testConnection(cfg.modelId)
        spin.stop()
        if (r.ok) process.stdout.write(p.green(`${ui.sym.check} connected `) + p.dim(`${r.message}${r.latencyMs ? ' · ' + r.latencyMs + 'ms' : ''}\n`))
        else process.stdout.write(p.red(`${ui.sym.cross} ${r.message}\n`))
      } catch (err) {
        spin.stop()
        process.stdout.write(p.red(`${ui.sym.cross} test failed: ${msg(err)}\n`))
      }
      continue
    }
    if (pick === 'gateway') {
      saveUserConfig({ provider: 'gateway' })
      process.stdout.write(p.green(`${ui.sym.check} provider → `) + p.cyan('gateway') + '\n')
      continue
    }
    if (pick === 'ollama') {
      saveUserConfig({ provider: 'ollama' })
      process.stdout.write(p.green(`${ui.sym.check} provider → `) + p.cyan('ollama (local)') + '\n')
      continue
    }
    if (pick === 'url') {
      const v = await askLine('https://api.openai.com/v1', 'gateway base URL')
      if (v) {
        saveUserConfig({ baseUrl: v })
        process.stdout.write(p.green(`${ui.sym.check} base URL → `) + p.cyan(v) + '\n')
      }
      continue
    }
    if (pick === 'key') {
      const v = await askLine('sk-…', 'gateway API key (input is echoed — paste carefully)')
      if (v) {
        saveUserConfig({ apiKey: v })
        process.stdout.write(p.green(`${ui.sym.check} API key saved `) + p.dim('(····' + v.slice(-4) + ')\n'))
      }
      continue
    }
    if (pick === 'ourl') {
      const v = await askLine(cfg.ollama.baseUrl, 'ollama base URL')
      if (v) {
        saveUserConfig({ ollamaUrl: v })
        process.stdout.write(p.green(`${ui.sym.check} ollama URL → `) + p.cyan(v) + '\n')
      }
    }
  }
}

/** Skills — browse, create and run instruction packs. */
async function skillsMenu(workspace: string): Promise<void> {
  const p = ui.paint
  if (!interactive()) {
    const scan = listSkills(workspace)
    if (scan.skills.length === 0) process.stdout.write(p.dim('  no skills yet — add markdown files to ~/.myto/skills\n'))
    for (const s of scan.skills) process.stdout.write(`  ${p.cyan(s.name.padEnd(20))}${p.dim(s.source)}\n`)
    return
  }
  for (;;) {
    const scan = listSkills(workspace)
    for (const e of scan.errors) process.stdout.write(p.amber(`  ⚠ ${e.path}: ${e.error}\n`))
    const options: ui.SelectOption<{ kind: 'run' | 'new' | 'back'; skill?: Skill }>[] = [
      ...scan.skills.map((s) => ({
        label: s.name,
        hint: `${s.source} · ${s.instructions.split('\n')[0].slice(0, 48)}${s.instructions.length > 48 ? '…' : ''}`,
        value: { kind: 'run' as const, skill: s }
      })),
      { label: 'New skill…', hint: 'write a starter skill file', value: { kind: 'new' } },
      { label: 'Back', value: { kind: 'back' } }
    ]
    const pick = await ui.select('Skills — instruction packs for the agent', options)
    if (!pick || pick.kind === 'back') return
    if (pick.kind === 'new') {
      const name = await askLine('code-review', 'skill name (the first "# heading" of the file)')
      if (!name) continue
      const desc = (await askLine('one-line description', 'what it is for')) ?? ''
      const path = saveSkill(workspace, name, skillTemplate(name, desc))
      process.stdout.write(p.green(`${ui.sym.check} skill written → `) + p.cyan(path) + '\n')
      continue
    }
    const skill = pick.skill!
    process.stdout.write('\n' + renderMarkdown(`## ${skill.name}\n\n${skill.instructions}`) + '\n')
    const task = await askLine(`Task for the ${skill.name} skill`, 'esc cancels')
    if (!task) continue
    await runMenuTask(task, workspace, {
      systemExtra: `You are operating under the "${skill.name}" skill. Follow these instructions for this task:\n\n${skill.instructions}`
    })
  }
}

/** Command — curated quick actions plus prompt/command plugins. */
async function actionsMenu(workspace: string): Promise<void> {
  const p = ui.paint
  if (!interactive()) {
    for (const a of QUICK_ACTIONS) process.stdout.write(`  ${p.cyan(a.label.padEnd(34))}${p.dim(a.hint)}\n`)
    return
  }
  for (;;) {
    const scan = listPlugins(workspace)
    for (const e of scan.errors) process.stdout.write(p.amber(`  ⚠ ${e.path}: ${e.error}\n`))
    const options: ui.SelectOption<{ kind: 'builtin' | 'prompt' | 'command' | 'back'; action?: QuickAction; plugin?: PluginManifest }>[] = [
      ...QUICK_ACTIONS.map((a) => ({ label: a.label, hint: a.hint, value: { kind: 'builtin' as const, action: a } })),
      ...scan.plugins
        .filter((pl) => pl.kind === 'prompt')
        .map((pl) => ({ label: pl.title, hint: 'plugin · ' + (pl.description ?? pl.name), value: { kind: 'prompt' as const, plugin: pl } })),
      ...scan.plugins
        .filter((pl) => pl.kind === 'command')
        .map((pl) => ({ label: pl.title, hint: 'command · $ ' + pl.command, value: { kind: 'command' as const, plugin: pl } })),
      { label: 'Back', value: { kind: 'back' } }
    ]
    const pick = await ui.select('Command — quick actions and automation', options)
    if (!pick || pick.kind === 'back') return
    if (pick.kind === 'builtin') {
      await runMenuTask(pick.action!.task(workspace), workspace)
      continue
    }
    if (pick.kind === 'prompt') {
      await runMenuTask(pick.plugin!.prompt!, workspace)
      continue
    }
    if (pick.kind === 'command') {
      const cmdText = pick.plugin!.command!
      process.stdout.write(p.amber(`$ ${cmdText}\n`))
      const out = await runCliCommand(cmdText, workspace)
      process.stdout.write(p.dim(out.trim() || '(no output)') + '\n')
    }
  }
}

/** Plugin — inspect, create and manage local plugin manifests. */
async function pluginsMenu(workspace: string): Promise<void> {
  const p = ui.paint
  if (!interactive()) {
    const scan = listPlugins(workspace)
    if (scan.plugins.length === 0) process.stdout.write(p.dim('  no plugins yet — add JSON manifests to ~/.myto/plugins\n'))
    for (const pl of scan.plugins) process.stdout.write(`  ${p.cyan(pl.title.padEnd(20))}${p.dim(pl.kind + ' · ' + pl.name)}\n`)
    return
  }
  for (;;) {
    const scan = listPlugins(workspace)
    for (const e of scan.errors) process.stdout.write(p.amber(`  ⚠ ${e.path}: ${e.error}\n`))
    const options: ui.SelectOption<{ kind: 'inspect' | 'new' | 'back'; plugin?: PluginManifest }>[] = [
      ...scan.plugins.map((pl) => ({
        label: pl.title,
        hint: `${pl.kind} · ${pl.description ?? pl.name}`,
        value: { kind: 'inspect' as const, plugin: pl }
      })),
      { label: 'New plugin…', hint: 'write a starter manifest to ~/.myto/plugins', value: { kind: 'new' } },
      { label: 'Back', value: { kind: 'back' } }
    ]
    const pick = await ui.select('Plugin — extend Myto with local manifests', options)
    if (!pick || pick.kind === 'back') return
    if (pick.kind === 'new') {
      const name = await askLine('deploy-check', 'plugin name (a slug: lowercase-dashes)')
      if (!name) continue
      const title = (await askLine(name, 'display title')) ?? name
      const path = savePlugin(workspace, name, pluginTemplate(name, title))
      process.stdout.write(p.green(`${ui.sym.check} plugin written → `) + p.cyan(path) + '\n')
      process.stdout.write(p.dim('  edit it: "kind" is "prompt" (a reusable task) or "command" (a shell shortcut)\n'))
      continue
    }
    const pl = pick.plugin!
    process.stdout.write('\n')
    const rows: [string, string][] = [
      ['name', pl.name],
      ['title', pl.title],
      ['kind', pl.kind],
      ...(pl.description ? ([['description', pl.description]] as [string, string][]) : []),
      ...(pl.kind === 'prompt'
        ? ([['prompt', pl.prompt!]] as [string, string][])
        : ([['command', '$ ' + pl.command!]] as [string, string][]))
    ]
    process.stdout.write(rows.map(([k, v]) => `  ${p.gray(k.padEnd(12))}${p.cyan(v)}`).join('\n') + '\n\n')
    if (pl.kind === 'prompt' && (await ui.confirm('Run this plugin now?'))) await runMenuTask(pl.prompt!, workspace)
    if (pl.kind === 'command' && (await ui.confirm(`Run \`${pl.command}\` in the workspace now?`))) {
      process.stdout.write(p.amber(`$ ${pl.command}\n`))
      const out = await runCliCommand(pl.command!, workspace)
      process.stdout.write(p.dim(out.trim() || '(no output)') + '\n')
    }
  }
}

/**
 * The interactive app: banner + auth header, then the numbered main menu. Each
 * destination runs as its own sub-session and returns here; Esc/q on the menu
 * exits. Cowork is the classic REPL and comes back to the menu via /menu.
 */
async function app(dir?: string): Promise<number> {
  const workspace = resolveWorkspace(dir)
  process.stdout.write(ui.banner(VERSION))
  process.stdout.write(authHeader(loadConfig(), workspace) + '\n')
  for (;;) {
    const pick = await numberMenu(MAIN_MENU, 'What would you like to do?')
    if (pick === null) {
      process.stdout.write(ui.paint.dim('  bye ') + ui.paint.magenta(ui.sym.spark) + '\n')
      return 0
    }
    const cfg = loadConfig()
    if (pick === 0) {
      // Chat
      if (!isConfigured(cfg)) {
        process.stderr.write(notConfiguredMessage(cfg))
        continue
      }
      await chatSession({ provider: providerFromSettingsLike(cfg), modelId: cfg.modelId, isTty: ui.isTty })
    } else if (pick === 1) {
      // Cowork — the classic agent REPL; returns 2 to come back to the menu.
      const code = await repl(dir)
      if (code !== 2) return code
    } else if (pick === 2) {
      await connectorMenu()
    } else if (pick === 3) {
      await skillsMenu(workspace)
    } else if (pick === 4) {
      await actionsMenu(workspace)
    } else if (pick === 5) {
      await pluginsMenu(workspace)
    } else if (pick === 6) {
      await pickModelGlobal()
    }
  }
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
  let exitToMenu = false
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
    const stopWatch = watchInterrupt(controller, paused, ui.isTty)
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

  const pickModel = pickModelGlobal

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
      case 'menu':
        process.stdout.write(p.dim('  back to the main menu ') + p.gray('— /help anytime\n'))
        exitToMenu = true
        return true
      case 'chat':
        await chatSession({ provider: providerFromSettingsLike(cfg), modelId: cfg.modelId, isTty: ui.isTty })
        return false
      case 'skills':
        await skillsMenu(workspace)
        return false
      case 'command':
        await actionsMenu(workspace)
        return false
      case 'connector':
        await connectorMenu()
        cfg = loadConfig()
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
    cfg = loadConfig() // provider/model switches (Connector, Model) apply live
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
  return exitToMenu ? 2 : 0
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
  return app(args.dir)
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(ui.paint.red(`myto: ${msg(err)}\n`))
    process.exit(1)
  })
