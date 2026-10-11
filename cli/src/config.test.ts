import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normaliseForTest,
  isConfigured,
  configHint,
  resolveWorkspace,
  applyEnvForTest
} from './config'

describe('cli config', () => {
  it('normalises a flat user config (base-url/api-key/model keys)', () => {
    const cfg = normaliseForTest({
      activeProvider: 'gateway',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini'
    })
    expect(cfg.activeProvider).toBe('gateway')
    expect(cfg.gateway.baseUrl).toBe('https://api.example.com/v1')
    expect(cfg.gateway.apiKey).toBe('sk-test')
    expect(cfg.modelId).toBe('gpt-4o-mini')
    expect(isConfigured({ ...cfg, source: 'user' })).toBe(true)
  })

  it('normalises the app settings shape (gateway nested)', () => {
    const cfg = normaliseForTest({
      activeProvider: 'gateway',
      gateway: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', authSchema: 'bearer' },
      modelId: 'claude-sonnet-4-5'
    })
    expect(cfg.activeProvider).toBe('gateway')
    expect(cfg.gateway.baseUrl).toBe('https://api.anthropic.com/v1')
    expect(cfg.modelId).toBe('claude-sonnet-4-5')
    expect(cfg.gateway.authSchema).toBe('bearer')
  })

  it('an ollama config is configured with just a model', () => {
    const cfg = normaliseForTest({ activeProvider: 'ollama', modelId: 'llama3.1:8b' })
    expect(cfg.activeProvider).toBe('ollama')
    expect(isConfigured({ ...cfg, source: 'user' })).toBe(true)
  })

  it('an empty gateway config is not configured and produces a hint', () => {
    const cfg = normaliseForTest(null)
    const withSource = { ...cfg, source: 'none' as const }
    expect(isConfigured(withSource)).toBe(false)
    expect(configHint(withSource)).toContain('--base-url')
  })

  it('env vars override the stored config', () => {
    const base = normaliseForTest({ activeProvider: 'gateway', baseUrl: 'https://a/v1', model: 'm1' })
    const prev = {
      MYTO_BASE_URL: process.env.MYTO_BASE_URL,
      MYTO_API_KEY: process.env.MYTO_API_KEY,
      MYTO_MODEL: process.env.MYTO_MODEL
    }
    try {
      process.env.MYTO_BASE_URL = 'https://b/v1'
      process.env.MYTO_API_KEY = 'sk-env'
      process.env.MYTO_MODEL = 'm2'
      applyEnvForTest(base)
      expect(base.gateway.baseUrl).toBe('https://b/v1')
      expect(base.gateway.apiKey).toBe('sk-env')
      expect(base.modelId).toBe('m2')
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('resolveWorkspace prefers the flag, then MYTO_DIR, then cwd', () => {
    const prev = process.env.MYTO_DIR
    try {
      const flag = join(tmpdir(), 'from-flag')
      const fromEnv = join(tmpdir(), 'from-env')
      process.env.MYTO_DIR = fromEnv
      expect(resolveWorkspace(flag)).toBe(resolve(flag))
      expect(resolveWorkspace()).toContain('from-env')
      delete process.env.MYTO_DIR
      expect(resolveWorkspace()).toBe(process.cwd())
    } finally {
      if (prev === undefined) delete process.env.MYTO_DIR
      else process.env.MYTO_DIR = prev
    }
  })
})
