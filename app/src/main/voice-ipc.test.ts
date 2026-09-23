import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_PROVIDER_SETTINGS } from '../shared/defaults'
import type { ProviderSettings } from '../shared/types'

// voice-ipc imports `electron` for registerVoiceIpc; stub it so the module loads in Node.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

let stored: ProviderSettings
vi.mock('./settings', () => ({ getSettings: () => stored }))

import { transcribeAudio } from './voice-ipc'

const gatewaySettings = (over: Partial<ProviderSettings['gateway']> = {}): ProviderSettings => ({
  ...DEFAULT_PROVIDER_SETTINGS,
  activeProvider: 'gateway',
  gateway: {
    baseUrl: 'https://api.test/v1',
    apiKey: 'secret-key',
    authSchema: 'bearer',
    authHeaderName: 'Authorization',
    ...over
  }
})

const okResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Response

const errResponse = (status: number, detail: string): Response =>
  ({ ok: false, status, json: async () => null, text: async () => detail }) as unknown as Response

const fetchMock = vi.fn()

beforeEach(() => {
  stored = gatewaySettings()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transcribeAudio', () => {
  it('reports no-gateway when the active provider is not a gateway', async () => {
    stored = { ...DEFAULT_PROVIDER_SETTINGS, activeProvider: 'ollama' }
    expect(await transcribeAudio({ data: 'AAAA', mime: 'audio/webm' })).toEqual({
      ok: false,
      error: 'no-gateway'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports no-gateway when the base URL is empty', async () => {
    stored = gatewaySettings({ baseUrl: '' })
    expect(await transcribeAudio({ data: 'AAAA', mime: 'audio/webm' })).toEqual({
      ok: false,
      error: 'no-gateway'
    })
  })

  it('reports no-audio when there are no bytes', async () => {
    expect(await transcribeAudio({ data: '', mime: 'audio/webm' })).toEqual({
      ok: false,
      error: 'no-audio'
    })
  })

  it('posts the clip to the transcriptions endpoint with auth and returns the text', async () => {
    fetchMock.mockResolvedValue(okResponse({ text: '  hello world  ' }))
    const result = await transcribeAudio({ data: Buffer.from('clip').toString('base64'), mime: 'audio/webm' })
    expect(result).toEqual({ ok: true, text: 'hello world' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key')
    expect(init.body).toBeInstanceOf(FormData)
  })

  it('surfaces an HTTP error from the endpoint', async () => {
    fetchMock.mockResolvedValue(errResponse(404, 'no such model'))
    const result = await transcribeAudio({ data: 'AAAA', mime: 'audio/webm' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/404/)
    expect(result.error).toMatch(/no such model/)
  })

  it('treats an empty transcription as a failure', async () => {
    fetchMock.mockResolvedValue(okResponse({ text: '   ' }))
    expect(await transcribeAudio({ data: 'AAAA', mime: 'audio/webm' })).toEqual({
      ok: false,
      error: 'empty'
    })
  })
})
