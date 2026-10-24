import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'

// settings.ts imports `app` from 'electron'; the real package's entry resolves to
// a binary path (and can even trigger a download on import), so we stub it. The
// save/getSettings round-trip tests below actually hit the filesystem through this
// stubbed userData path, so it points at a per-run temp dir (unique by pid) that
// afterAll removes. `vi.hoisted` computes it without top-level-variable capture in
// the hoisted mock factory.
const { USERDATA } = vi.hoisted(() => ({
  USERDATA: `${process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp'}/myto-settings-test-${process.pid}`
}))
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))

import { normalise, saveSettings, getSettings, setUserDataDir, setSettingsSavedListener } from '@main/settings'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

const BASE = DEFAULT_PROVIDER_SETTINGS

afterAll(() => {
  try {
    rmSync(USERDATA, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of the temp userData dir
  }
})

describe('normalise — provider selection', () => {
  it('defaults to the baseline provider when absent or invalid', () => {
    expect(normalise({}).activeProvider).toBe(BASE.activeProvider)
    expect(normalise({ activeProvider: 'nonsense' }).activeProvider).toBe(BASE.activeProvider)
  })

  it('keeps a valid provider', () => {
    expect(normalise({ activeProvider: 'gateway' }).activeProvider).toBe('gateway')
    expect(normalise({ activeProvider: 'ollama' }).activeProvider).toBe('ollama')
  })
})

describe('normalise — ui preferences (theme + lastMode)', () => {
  it('defaults to the baseline theme when absent or invalid', () => {
    expect(normalise({}).ui.theme).toBe(BASE.ui.theme)
    expect(normalise({ ui: { theme: 'neon' } }).ui.theme).toBe(BASE.ui.theme)
  })

  it('keeps a valid theme', () => {
    expect(normalise({ ui: { theme: 'dark' } }).ui.theme).toBe('dark')
    expect(normalise({ ui: { theme: 'light' } }).ui.theme).toBe('light')
  })

  it('defaults to the baseline mode when absent or invalid, keeps a valid one', () => {
    expect(normalise({}).ui.lastMode).toBe(BASE.ui.lastMode)
    expect(normalise({ ui: { lastMode: 'nonsense' } }).ui.lastMode).toBe(BASE.ui.lastMode)
    expect(normalise({ ui: { lastMode: 'cowork' } }).ui.lastMode).toBe('cowork')
    expect(normalise({ ui: { lastMode: 'chat' } }).ui.lastMode).toBe('chat')
  })

  it('carries no agentic ui fields through (plain chatbot)', () => {
    const ui = normalise({
      ui: { theme: 'dark', fullAccess: true, mode: 'code', effort: 'max', workspaceRoot: '/x' }
    }).ui
    expect(ui).toEqual({ theme: 'dark', lastMode: 'chat' })
  })
})

describe('normalise — gateway auth', () => {
  it('defaults an invalid auth schema to the baseline', () => {
    expect(normalise({ gateway: { authSchema: 'weird' } }).gateway.authSchema).toBe(
      BASE.gateway.authSchema
    )
  })

  it('keeps a valid auth schema and a non-empty header name', () => {
    const out = normalise({
      gateway: { authSchema: 'header', authHeaderName: 'x-api-key' }
    })
    expect(out.gateway.authSchema).toBe('header')
    expect(out.gateway.authHeaderName).toBe('x-api-key')
  })

  it('falls back to the default header name when blank', () => {
    expect(normalise({ gateway: { authHeaderName: '  ' } }).gateway.authHeaderName).toBe(
      BASE.gateway.authHeaderName
    )
  })
})

describe('normalise — model fields', () => {
  it('keeps string model name/id and drops non-strings', () => {
    const out = normalise({ modelName: 'GPT-4o mini', modelId: 'gpt-4o-mini' })
    expect(out.modelName).toBe('GPT-4o mini')
    expect(out.modelId).toBe('gpt-4o-mini')

    const bad = normalise({ modelName: 42, modelId: null })
    expect(bad.modelName).toBe(BASE.modelName)
    expect(bad.modelId).toBe(BASE.modelId)
  })
})

describe('normalise — connectors (mcpServers)', () => {
  it('defaults to an empty list', () => {
    expect(normalise({}).mcpServers).toEqual([])
    expect(normalise({ mcpServers: 'nope' }).mcpServers).toEqual([])
  })

  it('keeps a valid stdio server and fills defaults', () => {
    const out = normalise({
      mcpServers: [{ id: 'a', name: 'Files', transport: 'stdio', command: 'npx', args: ['-y', 'x'] }]
    })
    expect(out.mcpServers).toHaveLength(1)
    expect(out.mcpServers[0]).toMatchObject({
      id: 'a',
      name: 'Files',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'x']
    })
  })

  it('keeps a valid http server with headers', () => {
    const out = normalise({
      mcpServers: [
        { id: 'b', name: 'API', enabled: false, transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer z' } }
      ]
    })
    expect(out.mcpServers[0]).toMatchObject({
      id: 'b',
      enabled: false,
      transport: 'http',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer z' }
    })
  })

  it('drops malformed entries (missing id/name, or a command/url)', () => {
    const out = normalise({
      mcpServers: [
        { name: 'no id', transport: 'stdio', command: 'x' }, // no id
        { id: 'c', name: 'no command', transport: 'stdio' }, // stdio without command
        { id: 'd', name: 'no url', transport: 'http' }, // http without url
        null,
        { id: 'e', name: 'ok', transport: 'stdio', command: 'run' } // the one keeper
      ]
    })
    expect(out.mcpServers.map((s) => s.id)).toEqual(['e'])
  })

  it('coerces an unknown transport to stdio', () => {
    const out = normalise({
      mcpServers: [{ id: 'f', name: 'x', transport: 'carrier-pigeon', command: 'run' }]
    })
    expect(out.mcpServers[0].transport).toBe('stdio')
  })
})

describe('normalise — skills', () => {
  it('defaults to an empty list and ignores non-arrays', () => {
    expect(normalise({}).skills).toEqual([])
    expect(normalise({ skills: 'nope' }).skills).toEqual([])
  })

  it('keeps a valid skill and defaults enabled to true', () => {
    const out = normalise({
      skills: [{ id: 's1', name: 'Review', description: 'd', instructions: 'do it' }]
    })
    expect(out.skills).toHaveLength(1)
    expect(out.skills[0]).toMatchObject({ id: 's1', name: 'Review', enabled: true })
  })

  it('drops skills missing id, name, or instructions', () => {
    const out = normalise({
      skills: [
        { name: 'no id', instructions: 'x' },
        { id: 'a', name: 'no instructions' },
        { id: 'b', name: 'ok', instructions: 'keep me' }
      ]
    })
    expect(out.skills.map((s) => s.id)).toEqual(['b'])
  })

  it('preserves a skill/server source tag (plugin provenance)', () => {
    const out = normalise({
      skills: [{ id: 's', name: 'x', instructions: 'y', source: 'plugin_1' }],
      mcpServers: [{ id: 'm', name: 'x', transport: 'stdio', command: 'run', source: 'plugin_1' }]
    })
    expect(out.skills[0].source).toBe('plugin_1')
    expect(out.mcpServers[0].source).toBe('plugin_1')
  })
})

describe('normalise — plugins', () => {
  it('defaults to an empty list and drops entries without id/name', () => {
    expect(normalise({}).plugins).toEqual([])
    expect(normalise({ plugins: [{ name: 'no id' }, { id: 'p', name: 'ok' }] }).plugins.map((p) => p.id)).toEqual(['p'])
  })
})

describe('normalise — cowork power fields (verify / plan / hooks)', () => {
  it('defaults the new cowork fields when absent', () => {
    const c = normalise({}).cowork
    expect(c.verifyCommand).toBe(BASE.cowork.verifyCommand)
    expect(c.planMode).toBe(BASE.cowork.planMode)
    expect(c.hooks).toEqual(BASE.cowork.hooks)
  })

  it('keeps a valid verify command and plan-mode flag', () => {
    const c = normalise({ cowork: { verifyCommand: 'npm test', planMode: true } }).cowork
    expect(c.verifyCommand).toBe('npm test')
    expect(c.planMode).toBe(true)
  })

  it('drops non-string / non-boolean values back to defaults', () => {
    const c = normalise({ cowork: { verifyCommand: 42, planMode: 'yes' } }).cowork
    expect(c.verifyCommand).toBe(BASE.cowork.verifyCommand)
    expect(c.planMode).toBe(BASE.cowork.planMode)
  })

  it('normalises hook commands, keeping strings and dropping the rest', () => {
    const c = normalise({ cowork: { hooks: { preToolUse: 'echo pre', postToolUse: 5 } } }).cowork
    expect(c.hooks.preToolUse).toBe('echo pre')
    expect(c.hooks.postToolUse).toBe(BASE.cowork.hooks.postToolUse)
  })
})

describe('normalise — output style + native tools', () => {
  it('defaults output style when absent or invalid, keeps a valid one', () => {
    expect(normalise({}).outputStyle).toBe(BASE.outputStyle)
    expect(normalise({ outputStyle: 'shouty' }).outputStyle).toBe(BASE.outputStyle)
    expect(normalise({ outputStyle: 'concise' }).outputStyle).toBe('concise')
  })

  it('defaults nativeTools to on; a pre-flip stored false is upgraded exactly once', () => {
    expect(normalise({}).nativeTools).toBe(true)
    // Pre-flip settings carry the old default as an explicit false — upgraded on
    // first load (the migration flag is unset), then respected from then on.
    expect(normalise({ nativeTools: false }).nativeTools).toBe(true)
    expect(normalise({ nativeTools: false }).nativeToolsMigrated).toBe(true)
    // Post-flip, a stored false is a real user opt-out and is honoured.
    expect(normalise({ nativeTools: false, nativeToolsMigrated: true }).nativeTools).toBe(false)
    expect(normalise({ nativeTools: true, nativeToolsMigrated: true }).nativeTools).toBe(true)
    expect(normalise({ nativeTools: 'yes' }).nativeTools).toBe(BASE.nativeTools)
  })
})

describe('normalise — background autonomy', () => {
  it('defaults both flags to off when the block is absent', () => {
    const bg = normalise({}).background
    expect(bg.keepAliveInTray).toBe(false)
    expect(bg.inboxEvery10min).toBe(false)
  })

  it('keeps a boolean keepAliveInTray and ignores a non-boolean', () => {
    expect(normalise({ background: { keepAliveInTray: true } }).background.keepAliveInTray).toBe(true)
    expect(normalise({ background: { keepAliveInTray: 'yes' } }).background.keepAliveInTray).toBe(
      false
    )
  })

  it('keeps a boolean inboxEvery10min and ignores a non-boolean', () => {
    expect(normalise({ background: { inboxEvery10min: true } }).background.inboxEvery10min).toBe(
      true
    )
    expect(normalise({ background: { inboxEvery10min: 1 } }).background.inboxEvery10min).toBe(false)
  })

  it('a partial block leaves the other flag at its default', () => {
    const bg = normalise({ background: { keepAliveInTray: true } }).background
    expect(bg.keepAliveInTray).toBe(true)
    expect(bg.inboxEvery10min).toBe(false)
  })
})

// The on-disk round-trip through the stubbed userData path: a save normalises and
// persists, and a fresh read (cache cleared) returns exactly the saved shape.
describe('saveSettings / getSettings round-trip', () => {
  beforeEach(() => {
    // Reset the module cache so getSettings re-reads from disk.
    setUserDataDir(USERDATA)
  })

  it('persists a saved value and reads it back after the cache is cleared', () => {
    const saved = saveSettings({
      ...BASE,
      activeProvider: 'gateway',
      modelId: 'gpt-4o-mini',
      modelName: 'GPT-4o mini',
      ui: { theme: 'dark', lastMode: 'chat' }
    })
    expect(saved.activeProvider).toBe('gateway')
    expect(saved.ui.theme).toBe('dark')

    setUserDataDir(USERDATA) // drop the cache
    const read = getSettings()
    expect(read.activeProvider).toBe('gateway')
    expect(read.modelId).toBe('gpt-4o-mini')
    expect(read.modelName).toBe('GPT-4o mini')
    expect(read.ui.theme).toBe('dark')
  })

  it('notifies the saved-listener with the normalised value', () => {
    const seen: string[] = []
    setSettingsSavedListener((s) => seen.push(s.ui.theme))
    saveSettings({ ...BASE, ui: { theme: 'light', lastMode: 'chat' } })
    expect(seen).toContain('light')
    setSettingsSavedListener(null)
  })
})
