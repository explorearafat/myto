import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  normaliseBaseUrl,
  stallGuard,
  StallError,
  toErrorMessage,
  TimeoutError,
  httpStatusOf,
  rateLimitRetryDelay,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RETRY_WAIT_MS
} from '@main/providers/http'
import { modelInfo } from '@main/providers/provider'
import { OllamaProvider } from '@main/providers/ollama'
import { GatewayProvider } from '@main/providers/gateway'
import { pickAdapter, openAiAdapter, anthropicAdapter } from '@main/providers/adapters'
import type { CompletionOptions, GatewayConfig, NativeToolCall } from '@shared/types'

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

  it('humanizes a 429 into a rate-limit explanation with a way out', () => {
    // The raw "HTTP 429 Too Many Requests" is opaque; a tagged 429 must explain the
    // free-tier cap and point at Rewrite / another model instead.
    const rate = Object.assign(new Error('HTTP 429 Too Many Requests'), { httpStatus: 429 })
    const msg = toErrorMessage(rate)
    expect(msg).toMatch(/rate-limit/i)
    expect(msg).toMatch(/rewrite/i)
    // A non-429 HTTP error keeps its raw message (no false rate-limit framing).
    const other = Object.assign(new Error('HTTP 500 Internal Server Error'), { httpStatus: 500 })
    expect(toErrorMessage(other)).toBe('HTTP 500 Internal Server Error')
  })
})

describe('rateLimitRetryDelay', () => {
  it('reads the numeric status a provider tagged onto the error', () => {
    expect(httpStatusOf(Object.assign(new Error('x'), { httpStatus: 429 }))).toBe(429)
    expect(httpStatusOf(new Error('x'))).toBeUndefined()
    expect(httpStatusOf(null)).toBeUndefined()
    expect(httpStatusOf('nope')).toBeUndefined()
  })

  it('retries a 429 and honours Retry-After (capped), on the first attempt', () => {
    const err = Object.assign(new Error('HTTP 429'), { httpStatus: 429, retryAfterMs: 4_000 })
    expect(rateLimitRetryDelay(err, 0)).toBe(4_000)
    // A hostile Retry-After is clamped so it can't freeze the turn.
    const hostile = Object.assign(new Error('HTTP 429'), { httpStatus: 429, retryAfterMs: 10 * 60_000 })
    expect(rateLimitRetryDelay(hostile, 0)).toBe(MAX_RETRY_WAIT_MS)
  })

  it('backs off exponentially when there is no Retry-After', () => {
    const err = Object.assign(new Error('HTTP 503'), { httpStatus: 503 })
    // 1s, 2s, 4s bases (+ up to 250ms jitter), each attempt roughly double the last.
    const a0 = rateLimitRetryDelay(err, 0) as number
    const a1 = rateLimitRetryDelay(err, 1) as number
    const a2 = rateLimitRetryDelay(err, 2) as number
    expect(a0).toBeGreaterThanOrEqual(1_000)
    expect(a0).toBeLessThan(1_250)
    expect(a1).toBeGreaterThanOrEqual(2_000)
    expect(a1).toBeLessThan(2_250)
    expect(a2).toBeGreaterThanOrEqual(4_000)
    expect(a2).toBeLessThan(4_250)
  })

  it('stops after the retry budget is spent', () => {
    const err = Object.assign(new Error('HTTP 429'), { httpStatus: 429 })
    expect(rateLimitRetryDelay(err, MAX_RATE_LIMIT_RETRIES)).toBeNull()
    expect(rateLimitRetryDelay(err, MAX_RATE_LIMIT_RETRIES + 5)).toBeNull()
  })

  it('never retries a non-transient status or an untagged error', () => {
    expect(rateLimitRetryDelay(Object.assign(new Error('x'), { httpStatus: 400 }), 0)).toBeNull()
    expect(rateLimitRetryDelay(Object.assign(new Error('x'), { httpStatus: 401 }), 0)).toBeNull()
    expect(rateLimitRetryDelay(Object.assign(new Error('x'), { httpStatus: 500 }), 0)).toBeNull()
    expect(rateLimitRetryDelay(new Error('network blip'), 0)).toBeNull()
    expect(rateLimitRetryDelay(new StallError(60_000), 0)).toBeNull()
  })

  it('retries the transient upstream 5xx family (502/503/504)', () => {
    for (const status of [502, 503, 504]) {
      expect(rateLimitRetryDelay(Object.assign(new Error('x'), { httpStatus: status }), 0)).not.toBeNull()
    }
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

  it('clamps the Myto-internal "max" effort down to the wire vocabulary "high"', async () => {
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

// ── Wire-format adapters (auto-detected by base URL) ─────────────────────────

describe('pickAdapter', () => {
  it('selects the Anthropic adapter for the real Anthropic API host', () => {
    expect(pickAdapter('https://api.anthropic.com')).toBe(anthropicAdapter)
    expect(pickAdapter('https://api.anthropic.com/v1')).toBe(anthropicAdapter)
  })

  it('selects the Anthropic adapter for any *.anthropic.com host', () => {
    expect(pickAdapter('https://gw.anthropic.com/v1')).toBe(anthropicAdapter)
  })

  it('keeps the OpenAI adapter for ordinary OpenAI-compatible hosts', () => {
    expect(pickAdapter('https://api.openai.com/v1')).toBe(openAiAdapter)
    expect(pickAdapter('https://api.example.com/v1')).toBe(openAiAdapter)
    // "anthropic" appearing as a path segment on another host is not a match.
    expect(pickAdapter('https://myproxy.dev/anthropic')).toBe(openAiAdapter)
  })

  it('falls back to Anthropic when the base explicitly targets /v1/messages off-domain', () => {
    expect(pickAdapter('https://proxy.example.com/v1/messages')).toBe(anthropicAdapter)
  })

  it('defaults to OpenAI for an empty or unparseable base URL', () => {
    expect(pickAdapter('')).toBe(openAiAdapter)
    expect(pickAdapter('not a url')).toBe(openAiAdapter)
  })
})

describe('GatewayProvider — Anthropic endpoint (auto-detected)', () => {
  const fetchMock = vi.fn()
  // authSchema is 'bearer' on purpose: the Anthropic adapter must IGNORE it and
  // send its own dual headers, proving detection overrides the saved auth scheme.
  const anthropicConfig: GatewayConfig = {
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-key',
    authSchema: 'bearer',
    authHeaderName: 'Authorization'
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  // A well-formed Anthropic message stream: the SSE reader only sees `data:`
  // lines, and each payload is dispatched on its own `type`. No `[DONE]`.
  function anthropicSse(...texts: string[]): Response {
    const lines: string[] = [
      'data: {"type":"message_start","message":{"id":"msg_1"}}\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n'
    ]
    for (const t of texts) {
      lines.push(
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n`
      )
    }
    lines.push('data: {"type":"content_block_stop","index":0}\n')
    lines.push('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n')
    lines.push('data: {"type":"message_stop"}\n')
    return streamedResponse(lines, 'text/event-stream')
  }

  async function collect(res: Response): Promise<{ text: string; reasoning: string; done: boolean }> {
    fetchMock.mockResolvedValue(res)
    const provider = new GatewayProvider(anthropicConfig)
    let text = ''
    let reasoning = ''
    let done = false
    await provider.streamCompletion('claude-3-5-sonnet-20241022', [{ role: 'user', content: 'hi' }], (c) => {
      if (c.delta) text += c.delta
      if (c.reasoning) reasoning += c.reasoning
      if (c.done) done = true
    })
    return { text, reasoning, done }
  }

  it('POSTs to /v1/messages with BOTH required auth headers and no bearer', async () => {
    fetchMock.mockResolvedValue(anthropicSse('ok'))
    const provider = new GatewayProvider(anthropicConfig)
    await provider.streamCompletion('claude-3-5-sonnet-20241022', [{ role: 'user', content: 'hi' }], () => {})

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.Authorization).toBeUndefined()
  })

  it('joins the messages path without doubling a trailing /v1', async () => {
    fetchMock.mockResolvedValue(anthropicSse('ok'))
    const provider = new GatewayProvider({ ...anthropicConfig, baseUrl: 'https://api.anthropic.com/v1' })
    await provider.streamCompletion('claude-3-5-sonnet-20241022', [{ role: 'user', content: 'hi' }], () => {})
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
  })

  it('hoists system turns to a top-level system string and defaults max_tokens', async () => {
    fetchMock.mockResolvedValue(anthropicSse('ok'))
    const provider = new GatewayProvider(anthropicConfig)
    await provider.streamCompletion(
      'claude-3-5-sonnet-20241022',
      [
        { role: 'system', content: 'You are Myto.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hi' }
      ],
      () => {}
    )
    const body = sentBody(fetchMock)
    expect(body.system).toBe('You are Myto.\n\nBe concise.')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    // Anthropic requires max_tokens; the default is the "effectively infinite output"
    // ceiling (32000), sent when no explicit maxTokens cap is requested.
    expect(body.max_tokens).toBe(32000)
    expect(body.stream).toBe(true)
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('never sends reasoning_effort even when an effort is requested', async () => {
    fetchMock.mockResolvedValue(anthropicSse('ok'))
    const provider = new GatewayProvider(anthropicConfig)
    await provider.getCompletion('claude-3-5-sonnet-20241022', [{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'high'
    })
    const body = sentBody(fetchMock)
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })

  it('honours an explicit maxTokens (the max tier)', async () => {
    fetchMock.mockResolvedValue(anthropicSse('ok'))
    const provider = new GatewayProvider(anthropicConfig)
    await provider.getCompletion('claude-3-5-sonnet-20241022', [{ role: 'user', content: 'hi' }], {
      maxTokens: 32000
    })
    expect(sentBody(fetchMock).max_tokens).toBe(32000)
  })

  it('transforms an image attachment into an Anthropic base64 image block', async () => {
    fetchMock.mockResolvedValue(anthropicSse('ok'))
    const provider = new GatewayProvider(anthropicConfig)
    await provider.getCompletion('claude-3-5-sonnet-20241022', [
      { role: 'user', content: 'describe', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }
    ])
    expect(sentBody(fetchMock).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]
      }
    ])
  })

  it('streams text_delta events as reply deltas', async () => {
    const { text, done } = await collect(anthropicSse('He', 'llo'))
    expect(text).toBe('Hello')
    expect(done).toBe(true)
  })

  it('routes a thinking_delta to reasoning, never into the reply text', async () => {
    const res = streamedResponse(
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n',
        'data: {"type":"message_stop"}\n'
      ],
      'text/event-stream'
    )
    const { text, reasoning, done } = await collect(res)
    expect(text).toBe('Hi')
    expect(reasoning).toBe('hmm')
    expect(done).toBe(true)
  })

  it('throws on an in-band Anthropic error event', async () => {
    const res = streamedResponse(
      ['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n'],
      'text/event-stream'
    )
    fetchMock.mockResolvedValue(res)
    const provider = new GatewayProvider(anthropicConfig)
    await expect(
      provider.streamCompletion('claude-3-5-sonnet-20241022', [{ role: 'user', content: 'hi' }], () => {})
    ).rejects.toThrow(/Overloaded/)
  })

  it('parses a buffered content[] body when the endpoint ignores stream:true', async () => {
    const { text, done } = await collect(
      jsonResponse({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Buffered hi' }] })
    )
    expect(text).toBe('Buffered hi')
    expect(done).toBe(true)
  })

  it('throws on a buffered Anthropic error shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } })
    )
    const provider = new GatewayProvider(anthropicConfig)
    await expect(
      provider.streamCompletion('bad', [{ role: 'user', content: 'hi' }], () => {})
    ).rejects.toThrow(/bad model/)
  })

  it('lists models from /v1/models with display names', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' }] })
    )
    const provider = new GatewayProvider(anthropicConfig)
    const result = await provider.listModels()
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([{ id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' }])
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models')
  })

  it('collects getCompletion over the Anthropic stream', async () => {
    fetchMock.mockResolvedValue(anthropicSse('one ', 'two'))
    const provider = new GatewayProvider(anthropicConfig)
    const text = await provider.getCompletion('claude-3-5-sonnet-20241022', [{ role: 'user', content: 'hi' }])
    expect(text).toBe('one two')
    expect(sentBody(fetchMock).stream).toBe(true)
  })
})

// ── #15 Native function-calling (opt-in; text protocol stays the default) ─────
// These drive real (canned) SSE through `streamCompletion` and assert the gateway
// reassembles a tool call whose id / name / JSON arguments are split across many
// lines into ONE `toolCall` chunk — the single structural change #15 required
// (stateless-per-line parse → stateful per-stream parser). The request-body checks
// prove the schemas ride the wire only when tools are actually passed, so the flag
// stays a no-op when off.
describe('GatewayProvider — native function-calling (#15)', () => {
  const fetchMock = vi.fn()
  const openAiConfig: GatewayConfig = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret-key',
    authSchema: 'bearer',
    authHeaderName: 'Authorization'
  }
  const anthropicConfig: GatewayConfig = {
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-key',
    authSchema: 'bearer',
    authHeaderName: 'Authorization'
  }
  const weatherTool = {
    name: 'get_weather',
    description: 'Look up the weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  /** `data: <json>\n` for one SSE frame. */
  function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n`
  }

  /** A real SSE Response from pre-encoded `data:` lines (this block's local copy). */
  function sseResponse(lines: string[]): Response {
    return streamedResponse(lines, 'text/event-stream')
  }

  /** Drive a canned SSE response through streamCompletion, capturing every chunk shape. */
  async function collect(
    res: Response,
    config: GatewayConfig,
    options?: CompletionOptions
  ): Promise<{ text: string; toolCalls: NativeToolCall[]; done: boolean }> {
    fetchMock.mockResolvedValue(res)
    const provider = new GatewayProvider(config)
    let text = ''
    const toolCalls: NativeToolCall[] = []
    let done = false
    await provider.streamCompletion(
      'model-x',
      [{ role: 'user', content: 'weather in NYC?' }],
      (c) => {
        if (c.delta) text += c.delta
        if (c.toolCall) toolCalls.push(c.toolCall)
        if (c.done) done = true
      },
      undefined,
      options
    )
    return { text, toolCalls, done }
  }
  // __NATIVE_TESTS__

  it('reports native-tool support (both wire adapters can carry function-calling)', () => {
    expect(new GatewayProvider(openAiConfig).supportsNativeTools()).toBe(true)
    expect(new GatewayProvider(anthropicConfig).supportsNativeTools()).toBe(true)
  })

  it('injects OpenAI tools + tool_choice into the body only when tools are passed', async () => {
    await collect(sseResponse(['data: [DONE]\n']), openAiConfig, { tools: [weatherTool] })
    const body = sentBody(fetchMock)
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: weatherTool.description, parameters: weatherTool.parameters }
      }
    ])
    expect(body.tool_choice).toBe('auto')
  })

  it('never puts a tools key on the OpenAI wire when none are passed (off-by-default no-op)', async () => {
    await collect(sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: [DONE]\n']), openAiConfig)
    const body = sentBody(fetchMock)
    expect('tools' in body).toBe(false)
    expect('tool_choice' in body).toBe(false)
  })

  it('reassembles an OpenAI tool call whose id/name/arguments span many SSE lines', async () => {
    const { text, toolCalls, done } = await collect(
      sseResponse([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n'
      ]),
      openAiConfig,
      { tools: [weatherTool] }
    )
    expect(toolCalls).toEqual([{ id: 'call_abc', name: 'get_weather', argsJson: '{"city":"NYC"}' }])
    expect(text).toBe('') // a tool call carries no reply text
    expect(done).toBe(true)
  })

  // __NATIVE_TESTS_2__

  it('still emits an OpenAI call that ends at [DONE] without a finish_reason marker', async () => {
    // Some proxies drop finish_reason; the parser must release the pending call at
    // stream end rather than swallowing it, and never double-emit it.
    const { toolCalls, done } = await collect(
      sseResponse([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'get_weather', arguments: '{"city":"LA"}' } }] } }] }),
        'data: [DONE]\n'
      ]),
      openAiConfig,
      { tools: [weatherTool] }
    )
    expect(toolCalls).toEqual([{ id: 'call_x', name: 'get_weather', argsJson: '{"city":"LA"}' }])
    expect(done).toBe(true)
  })

  it('leaves the OpenAI text path untouched when tools are advertised but the model just talks', async () => {
    const { text, toolCalls, done } = await collect(
      sseResponse(['data: {"choices":[{"delta":{"content":"Sunny."}}]}\n', 'data: [DONE]\n']),
      openAiConfig,
      { tools: [weatherTool] }
    )
    expect(text).toBe('Sunny.')
    expect(toolCalls).toEqual([])
    expect(done).toBe(true)
  })

  it('injects Anthropic tools with input_schema (not OpenAI nested function) when passed', async () => {
    await collect(streamedResponse(['data: {"type":"message_stop"}\n'], 'text/event-stream'), anthropicConfig, {
      tools: [weatherTool]
    })
    const body = sentBody(fetchMock)
    expect(body.tools).toEqual([
      { name: 'get_weather', description: weatherTool.description, input_schema: weatherTool.parameters }
    ])
  })

  it('reassembles an Anthropic tool_use block from start / input_json_delta / stop', async () => {
    const { text, toolCalls, done } = await collect(
      streamedResponse(
        [
          sse({ type: 'message_start', message: { id: 'msg_1' } }),
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"NYC"}' } }),
          sse({ type: 'content_block_stop', index: 0 }),
          sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
          sse({ type: 'message_stop' })
        ],
        'text/event-stream'
      ),
      anthropicConfig,
      { tools: [weatherTool] }
    )
    expect(toolCalls).toEqual([{ id: 'toolu_1', name: 'get_weather', argsJson: '{"city":"NYC"}' }])
    expect(text).toBe('')
    expect(done).toBe(true)
  })

  it('releases a truncated Anthropic tool_use block via flush (no content_block_stop)', async () => {
    const { toolCalls } = await collect(
      streamedResponse(
        [
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_weather' } }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"SF"}' } })
        ],
        'text/event-stream'
      ),
      anthropicConfig,
      { tools: [weatherTool] }
    )
    expect(toolCalls).toEqual([{ id: 'toolu_2', name: 'get_weather', argsJson: '{"city":"SF"}' }])
  })
})
