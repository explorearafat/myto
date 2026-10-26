/*
 * First-run setup: the wizard a brand-new user walks through on `myto`. Provider
 * (gateway or local Ollama) → credentials (API key masked as it's typed) → model
 * picked from the live endpoint → working folder browsed with the keyboard or
 * the mouse. Every step is cancellable with Esc; nothing is saved until it
 * succeeds, and the key is never echoed or logged.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createProvider } from '@app/main/providers'
import { isConfigured, loadConfig, saveUserConfig } from './config'
import * as ui from './ui'
import * as input from './input'
import { startSpinner } from './spinner'

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** True when the terminal can drive the wizard's interactive menus. */
export function canRunSetup(): boolean {
  const stdin = process.stdin
  return ui.isTty && stdin.isTTY === true && typeof stdin.setRawMode === 'function'
}

/**
 * Read a secret in raw mode: every typed character prints as `*`, Backspace
 * edits, Enter commits, Esc cancels (null). Non-TTY falls back to a plain line
 * (pipes can't be secret anyway).
 */
export function readSecret(prompt: string): Promise<string | null> {
  const stdin = process.stdin
  const out = process.stdout
  if (!canRunSetup()) return input.readTask([], { placeholder: prompt })
  return new Promise((resolve) => {
    let secret = ''
    let settled = false
    const finish = (v: string | null): void => {
      if (settled) return
      settled = true
      out.write('\n')
      try {
        stdin.setRawMode(false)
      } catch {
        /* ignore */
      }
      stdin.pause()
      stdin.removeListener('data', onData)
      resolve(v)
    }
    const onData = (b: Buffer): void => {
      const s = b.toString('utf8')
      if (s === '\r' || s === '\n') return finish(secret)
      if (s === '\x03') return finish(null) // Ctrl-C
      if (s === '\x1b') return finish(null) // Esc
      if (s === '\x7f' || s === '\x08') {
        secret = secret.slice(0, -1)
      } else {
        const clean = s.replace(/[\x00-\x1f\x7f]/g, '')
        secret += clean
      }
      out.write('\r\x1b[K' + ui.paint.bold(prompt) + ' ' + '*'.repeat(secret.length))
    }
    out.write(ui.paint.bold(prompt) + ' ')
    try {
      stdin.setRawMode(true)
    } catch {
      return finish(null)
    }
    stdin.resume()
    stdin.on('data', onData)
  })
}

/** Directories inside `dir`, sorted, hidden ones last. Unreadable → []. */
export function listFolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b))
  } catch {
    return []
  }
}

type Pick = { t: 'use' } | { t: 'up' } | { t: 'cd'; d: string }

/**
 * Browse folders with arrows/mouse: descend into directories, go up, or commit
 * to the current one. Esc cancels (null).
 */
export async function pickFolder(start: string): Promise<string | null> {
  let cur = start
  for (;;) {
    const options: ui.SelectOption<Pick>[] = [
      { label: ui.sym.check + ' Use this folder', hint: cur, value: { t: 'use' } },
      { label: '↑  Up one level', value: { t: 'up' } },
      ...listFolders(cur).map((d) => ({ label: '▸  ' + d, value: { t: 'cd' as const, d } }))
    ]
    const pick = await ui.select(`Folder — choose where Myto works`, options)
    if (!pick) return null
    if (pick.t === 'use') return cur
    if (pick.t === 'up') cur = dirname(cur)
    else cur = join(cur, pick.d)
  }
}

/** Fetch the endpoint's models with a spinner; null on failure. */
async function fetchModels(baseUrl: string, apiKey: string, ollama: boolean): Promise<string[] | null> {
  const provider = createProvider(ollama ? 'ollama' : 'gateway', ollama ? { baseUrl } : { baseUrl, apiKey, authSchema: 'bearer', authHeaderName: 'Authorization' })
  const spin = startSpinner('Fetching models', '')
  try {
    const list = await provider.listModels()
    spin.stop()
    return list.ok ? list.models.map((m) => m.id) : null
  } catch (err) {
    spin.stop()
    process.stdout.write(ui.paint.red(`  ${msg(err)}\n`))
    return null
  }
}

export interface SetupResult {
  ok: boolean
  /** The chosen working folder (only meaningful when ok). */
  workspace?: string
}

/**
 * The full first-run wizard. Resolves ok:false when the user cancels a step.
 * Idempotent: a partially-completed earlier run is simply redone.
 */
export async function runSetup(defaultWorkspace: string): Promise<SetupResult> {
  const p = ui.paint
  process.stdout.write('\n' + p.bold('Set up Myto') + p.dim('  — provider, model, folder. Esc cancels the current step.\n\n'))

  const providerPick = await ui.select('Sign in with', [
    { label: 'OpenAI-compatible gateway', hint: 'OpenAI, OpenRouter, vLLM, any /v1 endpoint', value: 'gateway' },
    { label: 'Ollama (local)', hint: 'free and offline, models run on this machine', value: 'ollama' }
  ])
  if (!providerPick) return { ok: false }

  if (providerPick === 'gateway') {
    const url = await input.readTask([], { placeholder: 'https://api.openai.com/v1', hint: 'gateway base URL · Enter keeps the default' })
    if (url === null) return { ok: false }
    const baseUrl = url.trim() || 'https://api.openai.com/v1'
    const key = await readSecret('API key')
    if (!key) return { ok: false }
    saveUserConfig({ provider: 'gateway', baseUrl, apiKey: key })
    const models = await fetchModels(baseUrl, key, false)
    if (models && models.length > 0) {
      const model = await ui.select('Pick a model', models.slice(0, 60).map((m) => ({ label: m, value: m })))
      if (!model) return { ok: false }
      saveUserConfig({ model })
    } else {
      const manual = await input.readTask([], { placeholder: 'model id, e.g. gpt-4o-mini', hint: models ? 'the endpoint listed no models — type the id' : 'could not reach the endpoint — type the model id' })
      if (!manual?.trim()) return { ok: false }
      saveUserConfig({ model: manual.trim() })
    }
  } else {
    const urlRaw = await input.readTask([], { placeholder: 'http://localhost:11434', hint: 'ollama URL · Enter keeps the default' })
    if (urlRaw === null) return { ok: false }
    const baseUrl = urlRaw.trim() || 'http://localhost:11434'
    saveUserConfig({ provider: 'ollama', ollamaUrl: baseUrl })
    const models = await fetchModels(baseUrl, '', true)
    if (models && models.length > 0) {
      const model = await ui.select('Pick a model', models.slice(0, 60).map((m) => ({ label: m, value: m })))
      if (!model) return { ok: false }
      saveUserConfig({ model })
    } else {
      const manual = await input.readTask([], { placeholder: 'llama3.1:8b', hint: models ? 'ollama listed no models — pull one first (ollama pull …)' : 'could not reach ollama — is it running? type the model id' })
      if (!manual?.trim()) return { ok: false }
      saveUserConfig({ model: manual.trim() })
    }
  }

  const workspace = await pickFolder(defaultWorkspace)
  if (!workspace) return { ok: false }

  const cfg = loadConfig()
  if (!isConfigured(cfg)) return { ok: false }
  process.stdout.write(
    '\n' +
      p.green(`${ui.sym.check} Ready — `) +
      p.cyan(cfg.modelId) +
      p.dim(` via ${cfg.activeProvider} · workspace `) +
      p.cyan(workspace) +
      '\n'
  )
  return { ok: true, workspace }
}
