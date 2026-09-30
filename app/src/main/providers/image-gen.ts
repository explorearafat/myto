import type { GatewayConfig, GeneratedMedia } from '../../shared/types'
import { openAiAdapter } from './adapters'
import { COMPLETION_TIMEOUT_MS, httpJson, normaliseBaseUrl } from './http'

/**
 * Media generation over an OpenAI-compatible gateway (Feature B). The user's BYOK endpoint
 * exposes `/images/generations` (the OpenAI Images shape); when the active model is an
 * image/video model we POST the prompt there and turn the reply into {@link GeneratedMedia}.
 *
 * The parsing is split out as a PURE function ({@link parseMediaResponse}) so it is fully
 * unit-tested against the several response shapes real gateways use, without any network.
 * The runtime wrappers ({@link generateImages}/{@link generateVideo}) are the thin fetch layer.
 *
 * This never fires for a chat model — the caller (provider-ipc) only reaches here after
 * {@link detectModelKind} classifies the turn as `image`/`video`, so an ordinary Claude/GPT
 * turn is completely untouched. And it always uses the user's OWN configured endpoint and
 * key: no third-party or telemetry call is ever introduced.
 */

/** How big / how many, mirrored onto the request body. */
export interface MediaGenOptions {
  n?: number
  size?: string
}

/** A base64 image's MIME type sniffed from its leading bytes; PNG is the safe default. */
export function sniffImageMimeFromBase64(b64: string): string {
  const head = b64.slice(0, 16)
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('iVBORw0KGgo')) return 'image/png'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  if (head.startsWith('UklGR')) return 'image/webp'
  if (head.startsWith('PHN2Zy') || head.startsWith('PD94bWw')) return 'image/svg+xml'
  return 'image/png'
}

/** Strip a `data:<mime>;base64,` prefix if the provider left one on the payload. */
function stripDataUrl(s: string): { mediaType?: string; b64: string } {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/is.exec(s.trim())
  if (m) return { mediaType: m[1] || undefined, b64: (m[2] ?? '').trim() }
  return { b64: s.trim() }
}

/** MIME for a media URL, guessed from its extension; falls back per media kind. */
function mimeFromUrl(url: string, kind: 'image' | 'video'): string {
  const ext = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1] ?? '').toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    gifv: 'video/mp4'
  }
  return map[ext] ?? (kind === 'video' ? 'video/mp4' : 'image/png')
}

/** Coerce one raw entry (string URL/b64, or an object) into a {@link GeneratedMedia}. */
function coerceItem(item: unknown, kind: 'image' | 'video', prompt: string | undefined): GeneratedMedia | null {
  if (typeof item === 'string') {
    const s = item.trim()
    if (!s) return null
    if (/^https?:\/\//i.test(s)) return { kind, mediaType: mimeFromUrl(s, kind), url: s, prompt }
    const { mediaType, b64 } = stripDataUrl(s)
    if (!b64) return null
    return { kind, mediaType: mediaType ?? (kind === 'video' ? 'video/mp4' : sniffImageMimeFromBase64(b64)), dataBase64: b64, prompt }
  }
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>
    const b64raw = o.b64_json ?? o.b64 ?? o.base64 ?? o.image ?? o.data
    if (typeof b64raw === 'string' && b64raw.trim()) {
      const { mediaType, b64 } = stripDataUrl(b64raw)
      if (b64) return { kind, mediaType: mediaType ?? (kind === 'video' ? 'video/mp4' : sniffImageMimeFromBase64(b64)), dataBase64: b64, prompt }
    }
    const url = o.url ?? o.video_url ?? o.image_url
    if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
      return { kind, mediaType: mimeFromUrl(url.trim(), kind), url: url.trim(), prompt }
    }
  }
  return null
}

/**
 * Turn a media-generation HTTP reply into {@link GeneratedMedia}[] — pure and defensive so it
 * copes with the shapes gateways actually return: OpenAI `{data:[{b64_json|url}]}`, a bare
 * `{images:[…]}` / `{output:…}` / `{artifacts:[{base64}]}`, or a raw string. Returns `[]` when
 * nothing usable is found (the caller then reports a friendly error rather than crashing).
 */
export function parseMediaResponse(raw: unknown, kind: 'image' | 'video', prompt?: string): GeneratedMedia[] {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      data = raw // a bare URL / data-url string
    }
  }
  const out: GeneratedMedia[] = []
  const push = (v: unknown): void => {
    const m = coerceItem(v, kind, prompt)
    if (m) out.push(m)
  }
  if (typeof data === 'string') {
    push(data)
  } else if (Array.isArray(data)) {
    for (const v of data) push(v)
  } else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    const lists = [o.data, o.images, o.artifacts, o.output, o.videos, o.result]
    let found = false
    for (const list of lists) {
      if (Array.isArray(list)) {
        for (const v of list) push(v)
        found = true
      } else if (typeof list === 'string') {
        push(list)
        found = true
      }
    }
    // Some minimal gateways answer with a single top-level b64_json / url.
    if (!found) push(o)
  }
  return out
}

/** The OpenAI-compatible endpoint for image generation, derived from the chat base URL. */
export function imagesUrl(baseUrl: string): string {
  const base = normaliseBaseUrl(baseUrl).replace(/\/(?:chat\/completions|messages)\/*$/i, '')
  return `${base}/images/generations`
}

/** The best-effort video endpoint (non-standard; many gateways don't expose it). */
export function videosUrl(baseUrl: string): string {
  const base = normaliseBaseUrl(baseUrl).replace(/\/(?:chat\/completions|messages)\/*$/i, '')
  return `${base}/videos/generations`
}

/**
 * Generate image(s) from `prompt` on the user's gateway. Requests `b64_json` so the bytes
 * come back inline (they survive the provider expiring temporary URLs) and are easy to persist.
 */
export async function generateImages(
  baseUrl: string,
  config: GatewayConfig,
  model: string,
  prompt: string,
  opts: MediaGenOptions = {},
  signal?: AbortSignal
): Promise<GeneratedMedia[]> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: opts.n && opts.n > 0 ? opts.n : 1,
    response_format: 'b64_json'
  }
  if (opts.size) body.size = opts.size
  const data = await httpJson<unknown>(imagesUrl(baseUrl), {
    method: 'POST',
    headers: openAiAdapter.authHeaders(config),
    body,
    timeoutMs: COMPLETION_TIMEOUT_MS,
    signal
  })
  return parseMediaResponse(data, 'image', prompt)
}

/**
 * Best-effort video generation. Video-gen wire formats are not standardised, so this posts a
 * minimal prompt body and parses whatever the gateway returns (URL or inline bytes). If the
 * endpoint doesn't exist the HTTP error propagates and the caller reports it plainly.
 */
export async function generateVideo(
  baseUrl: string,
  config: GatewayConfig,
  model: string,
  prompt: string,
  opts: MediaGenOptions = {},
  signal?: AbortSignal
): Promise<GeneratedMedia[]> {
  const body: Record<string, unknown> = { model, prompt }
  if (opts.size) body.size = opts.size
  const data = await httpJson<unknown>(videosUrl(baseUrl), {
    method: 'POST',
    headers: openAiAdapter.authHeaders(config),
    body,
    timeoutMs: COMPLETION_TIMEOUT_MS,
    signal
  })
  return parseMediaResponse(data, 'video', prompt)
}
