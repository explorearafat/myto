import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  normaliseBaseUrl,
  stallGuard,
  StallError,
  toErrorMessage,
  TimeoutError
} from '@main/providers/http'
import { modelInfo } from '@main/providers/provider'
import { OllamaProvider } from '@main/providers/ollama'
import { GatewayProvider } from '@main/providers/gateway'
import type { GatewayConfig } from '@shared/types'

describe('http helpers', () => {
  it('normalises base URLs by trimming trailing slashes and whitespace', () => {
    expect(normaliseBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434')
    expect(normaliseBaseUrl('  https://api.example.com/v1//  ')).toBe('https://api.example.com/v1')
    expect(normaliseBaseUrl('http://x')).toBe('http://x')
  })

  it('maps common network error codes to friendly messages', () => {
    const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(toErrorMessage(refused)).toMatch(/is the server running/i)

    const notFound = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    expect(toErrorMessage(notFound)).toMatch(/host not found/i)

    expect(toErrorMessage(new TimeoutError(15000))).toMatch(/timed out/i)
    expect(toErrorMessage('boom')).toBe('boom')
  })
})

describe('modelInfo', () => {
  it('falls back to the id when no display name is given', () => {
    expect(modelInfo('llama3.1:8b')).toEqual({ id: 'llama3.1:8b', name: 'llama3.1:8b' })
    expect(modelInfo('gpt-4o', 'GPT-4o')).toEqual({ id: 'gpt-4o', name: 'GPT-4o' })
    expect(modelInfo('x', '   ')).toEqual({ id: 'x', name: 'x' })
  })
})

describe('stallGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stays disarmed until the first touch', () => {
    // Nothing is being watched before bytes flow — the headers deadline owns
    // that window, and double-counting it would cap a slow first token.
    const guard = stallGuard(1_000)
    vi.advanceTimersByTime(10_000)
    expect(guard.signal.aborted).toBe(false)
    expect(guard.expired).toBe(false)
  })

  it('re-arms on every touch, so a long-but-alive stream is never cut off', () => {
    const guard = stallGuard(1_000)
    for (let i = 0; i < 20; i++) {
      guard.touch()
      vi.advanceTimersByTime(900)
    }
    // 18s of wall clock, none of it silent for a full second.
    expect(guard.signal.aborted).toBe(false)
    expect(guard.expired).toBe(false)
  })

  it('aborts with a StallError once the silence exceeds the window', () => {
    const guard = stallGuard(1_000)
    guard.touch()
    vi.advanceTimersByTime(1_000)

    expect(guard.signal.aborted).toBe(true)
    expect(guard.expired).toBe(true)
    expect(guard.signal.reason).toBeInstanceOf(StallError)
    expect(toErrorMessage(guard.signal.reason)).toMatch(/stalled/i)
  })

  it('chains an outer abort through without claiming the stream stalled', () => {
    // A user Stop must read as a cancellation, not as a dead endpoint.
    const outer = new AbortController()
    const guard = stallGuard(1_000, outer.signal)
    guard.touch()
    outer.abort()

    expect(guard.signal.aborted).toBe(true)
    expect(guard.expired).toBe(false)
    // The chained abort also disarmed the timer, so time passing changes nothing.
    vi.advanceTimersByTime(60_000)
    expect(guard.expired).toBe(false)
  })

  it('aborts immediately when the outer signal is already aborted', () => {
    const outer = new AbortController()
    outer.abort()
    const guard = stallGuard(1_000, outer.signal)
    expect(guard.signal.aborted).toBe(true)
  })

  it('stop() disarms a pending window', () => {
    const guard = stallGuard(1_000)
    guard.touch()
    guard.stop()
    vi.advanceTimersByTime(60_000)
    expect(guard.signal.aborted).toBe(false)
  })

  it('never arms when the window is 0 (guard disabled)', () => {
    const guard = stallGuard(0)
    guard.touch()
    vi.advanceTimersByTime(60_000)
    expect(guard.signal.aborted).toBe(false)
  })
})

/**
 * A buffered (non-streaming) JSON response double.
 *
 * The `headers` stub and the truthy-but-unreadable `body` are load-bearing now
 * that `getCompletion` rides the streaming transport: the gateway reads
 * `content-type` to decide SSE-vs-buffered, and this shape is exactly the
 * "gateway ignored `stream:true`" case it has to keep handling.
 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null)
    },
    body: {},
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response
}

/**
 * A response with a *real* readable body, for the streaming paths — SSE for the
 * gateway, NDJSON for Ollama. Chunk boundaries are deliberately caller-controlled
 * so a test can split a line across two reads.
 */
function streamedResponse(chunks: string[], contentType: string): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    body
  } as unknown as Response
}

/** The request body of the nth `fetch` call, parsed. */
function sentBody(fetchMock: { mock: { calls: unknown[][] } }, n = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[n][1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe('OllamaProvider', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  /**
   * An Ollama chat stream: one NDJSON line per chunk, terminated by `done`.
   * `getCompletion` now collects over this endpoint, so the completion tests are
   * fed a real stream rather than a `stream:false` blob.
   */
  function ollamaStream(...contents: string[]): Response {
    const lines = contents.map(
      (c) => `${JSON.stringify({ message: { role: 'assistant', content: c } })}\n`
    )
    lines.push(`${JSON.stringify({ done: true })}\n`)
    return streamedResponse(lines, 'application/x-ndjson')
  }

  it('lists models from /api/tags', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] })
    )
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434/' })
    const result = await provider.listModels()

    expect(result.ok).toBe(true)
    expect(result.models.map((m) => m.id)).toEqual(['llama3.1:8b', 'qwen2.5:7b'])
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/tags')
  })

  it('reports a friendly error when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    )
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    const result = await provider.listModels()

    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.error).toMatch(/is the server running/i)
  })

  it('returns a successful test-connection result with latency', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { role: 'assistant', content: 'ok' } }))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    const result = await provider.testConnection('llama3.1:8b')

    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/llama3\.1:8b/)
    expect(typeof result.latencyMs).toBe('number')
  })

  it('validates via /api/tags when no model is selected', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ name: 'a' }, { name: 'b' }] }))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    const result = await provider.testConnection('')

    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/2 models/)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/tags')
  })

  it('maps a requested temperature into native options.temperature', async () => {
    fetchMock.mockResolvedValue(ollamaStream('ok'))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    await provider.getCompletion('llama3.1:8b', [{ role: 'user', content: 'hi' }], {
      temperature: 0.5
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.options).toEqual({ temperature: 0.5 })
    // Ollama has no reasoning_effort concept — it must never leak onto the wire.
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('ignores reasoningEffort and sends no options when only effort is given', async () => {
    fetchMock.mockResolvedValue(ollamaStream('ok'))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    await provider.getCompletion('llama3.1:8b', [{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'high'
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.options).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('maps a requested maxTokens into native options.num_predict', async () => {
    fetchMock.mockResolvedValue(ollamaStream('ok'))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    await provider.getCompletion('llama3.1:8b', [{ role: 'user', content: 'hi' }], {
      temperature: 0.7,
      maxTokens: 32_000
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.options).toEqual({ temperature: 0.7, num_predict: 32_000 })
  })

  it('expands an image attachment into the native images array (base64, no data: prefix)', async () => {
    fetchMock.mockResolvedValue(ollamaStream('ok'))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    await provider.getCompletion('llava', [
      { role: 'user', content: 'what is this?', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }
    ])

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'what is this?', images: ['AAAA'] })
  })

  it('leaves a text-only message as a plain string with no images key', async () => {
    fetchMock.mockResolvedValue(ollamaStream('ok'))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    await provider.getCompletion('llama3.1:8b', [{ role: 'user', content: 'hi' }])

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' })
    expect('images' in body.messages[0]).toBe(false)
  })

  it('collects getCompletion over the streaming endpoint, not stream:false', async () => {
    // The 120s ceiling bug: a `stream:false` request has only the *headers*
    // deadline to cover the whole generation, so a long answer was cut off and
    // replayed. Collecting over the stream makes silence the bound, not elapsed
    // time — and the concatenated result must be identical.
    fetchMock.mockResolvedValue(ollamaStream('Hel', 'lo ', 'world'))
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    const text = await provider.getCompletion('llama3.1:8b', [{ role: 'user', content: 'hi' }])

    expect(text).toBe('Hello world')
    expect(sentBody(fetchMock).stream).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/chat')
  })

  it('propagates a caller abort out of getCompletion', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      // Model a real fetch: reject with the abort reason the caller supplied.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
      })
    })
    const controller = new AbortController()
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
    const pending = provider.getCompletion(
      'llama3.1:8b',
      [{ role: 'user', content: 'hi' }],
      undefined,
      controller.signal
    )
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
  })
})

describe('GatewayProvider', () => {
  const fetchMock = vi.fn()
  const baseConfig: GatewayConfig = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret-key',
    authSchema: 'bearer',
    authHeaderName: 'Authorization'
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends a Bearer token when authSchema is "bearer"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o-mini' }] }))
    const provider = new GatewayProvider(baseConfig)
    await provider.listModels()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key')
  })

  it('sends a custom header when authSchema is "header"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const provider = new GatewayProvider({
      ...baseConfig,
      authSchema: 'header',
      authHeaderName: 'x-api-key'
    })
    await provider.listModels()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('secret-key')
    expect(headers.Authorization).toBeUndefined()
  })

  it('omits auth headers when authSchema is "none"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const provider = new GatewayProvider({ ...baseConfig, authSchema: 'none' })
    await provider.listModels()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = (init.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it('surfaces an auth hint on a 401 test connection', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad key' }, false, 401))
    const provider = new GatewayProvider(baseConfig)
    const result = await provider.testConnection('gpt-4o-mini')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
    expect(result.message).toMatch(/auth schema/i)
  })

  it('validates via /models when no model is selected', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o' }] }))
    const provider = new GatewayProvider(baseConfig)
    const result = await provider.testConnection('')

    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/1 model/)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/models')
  })

  it('adds an auth hint when model listing 401s during a no-model test', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad key' }, false, 401))
    const provider = new GatewayProvider(baseConfig)
    const result = await provider.testConnection('')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
    expect(result.message).toMatch(/auth schema/i)
  })

  it('requires a base URL', async () => {
    const provider = new GatewayProvider({ ...baseConfig, baseUrl: '' })
    const result = await provider.testConnection('gpt-4o-mini')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/base url/i)
  })

  // A real SSE Response: a ReadableStream of pre-encoded `data:` lines. (The
  // "gateway ignored stream:true" case is just `jsonResponse` — a buffered
  // application/json body — so it needs no separate double.)
  function sseResponse(lines: string[]): Response {
    return streamedResponse(lines, 'text/event-stream')
  }

  async function collectStream(res: Response): Promise<{ text: string; done: boolean }> {
    fetchMock.mockResolvedValue(res)
    const provider = new GatewayProvider(baseConfig)
    let text = ''
    let done = false
    await provider.streamCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }], (c) => {
      if (c.delta) text += c.delta
      if (c.done) done = true
    })
    return { text, done }
  }

  it('falls back to a JSON body when the gateway ignores stream:true', async () => {
    // The exact failure the user hit: connection tests fine, but a real message
    // came back as plain JSON, so the SSE reader emitted nothing. Now the content
    // is surfaced as a delta instead of silence.
    const { text, done } = await collectStream(
      jsonResponse({ choices: [{ message: { content: 'Hello from the gateway' } }] })
    )
    expect(text).toBe('Hello from the gateway')
    expect(done).toBe(true)
  })

  it('surfaces an error field from a non-streaming JSON body', async () => {
    const provider = new GatewayProvider(baseConfig)
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'model not found' } }))
    await expect(
      provider.streamCompletion('bad-model', [{ role: 'user', content: 'hi' }], () => {})
    ).rejects.toThrow(/model not found/)
  })

  it('still streams deltas from a real SSE response', async () => {
    const { text, done } = await collectStream(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"He"}}]}\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n',
        'data: [DONE]\n'
      ])
    )
    expect(text).toBe('Hello')
    expect(done).toBe(true)
  })

  it('sends reasoning_effort and drops temperature when an effort is requested', async () => {
    // Anthropic-backed proxies reject a custom temperature while extended thinking
    // is on, so effort and temperature must never ride together on the wire.
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    const provider = new GatewayProvider(baseConfig)
    await provider.getCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'high',
      temperature: 0.7
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.reasoning_effort).toBe('high')
    expect(body.temperature).toBeUndefined()
  })

  it('clamps the Sylor-internal "max" effort down to the wire vocabulary "high"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    const provider = new GatewayProvider(baseConfig)
    await provider.getCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'max'
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.reasoning_effort).toBe('high')
  })

  it('adds max_tokens alongside reasoning_effort when a cap is set (the "max" tier)', async () => {
    // max_tokens is orthogonal to the effort/temperature split — it must ride
    // together with reasoning_effort so a big build isn't truncated.
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    const provider = new GatewayProvider(baseConfig)
    await provider.getCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'max',
      maxTokens: 32_000
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.reasoning_effort).toBe('high')
    expect(body.max_tokens).toBe(32_000)
  })

  it('sends temperature only when no reasoning effort is requested', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    const provider = new GatewayProvider(baseConfig)
    await provider.getCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }], {
      temperature: 0.3
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.temperature).toBe(0.3)
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('expands an image attachment into OpenAI image_url content parts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    const provider = new GatewayProvider(baseConfig)
    await provider.getCompletion('gpt-4o', [
      { role: 'user', content: 'describe', images: [{ mediaType: 'image/jpeg', dataBase64: 'Zm9v' }] }
    ])

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,Zm9v' } }
      ]
    })
  })

  it('leaves a text-only message as a plain string content', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    const provider = new GatewayProvider(baseConfig)
    await provider.getCompletion('gpt-4o', [{ role: 'user', content: 'hi' }])

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('collects getCompletion over SSE and asks for stream:true', async () => {
    // Same root cause as the Ollama case: `getCompletion` must not send
    // `stream:false`, because then the headers deadline is the whole-generation
    // budget. It now rides the same SSE path streaming does.
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"one "}}]}\n',
        'data: {"choices":[{"delta":{"content":"two"}}]}\n',
        'data: [DONE]\n'
      ])
    )
    const provider = new GatewayProvider(baseConfig)
    const text = await provider.getCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }])

    expect(text).toBe('one two')
    expect(sentBody(fetchMock).stream).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions')
  })

  it('still collects getCompletion when the gateway ignores stream:true', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'buffered' } }] }))
    const provider = new GatewayProvider(baseConfig)
    const text = await provider.getCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }])
    expect(text).toBe('buffered')
  })

  it('reports an HTTP failure from getCompletion instead of returning empty text', async () => {
    // An empty string would look like a model that answered with nothing, and
    // the callers that parse JSON out of it would then "degrade" silently.
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500))
    const provider = new GatewayProvider(baseConfig)
    await expect(
      provider.getCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(/HTTP 500/)
  })
})
