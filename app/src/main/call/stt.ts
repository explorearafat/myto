/**
 * Desktop-side call speech recognition — ZERO setup.
 *
 * The phone's mic audio already streams to the desktop over WebRTC. This
 * module transcribes WAV segments of it through the SAME gateway the chat
 * uses (settings.gateway: baseUrl + the user's own key), with an
 * audio-capable model (OpenAI `input_audio` content parts — free Gemini
 * models on OpenRouter accept them). No extra endpoint, no extra key.
 *
 * The phone's on-device recognizer remains primary; this path only speaks up
 * when the phone's recognizer is silent (see the dedup in call-session).
 */
import { getSettings } from '../settings'
import type { GatewayConfig } from '../../shared/types'

export interface SttSegment {
  audioBase64: string
  mime: string
}

/** Is desktop-side STT possible (gateway configured + a model chosen)? */
export function sttEnabled(): boolean {
  const s = getSettings()
  return s.gateway.baseUrl.trim() !== '' && s.call.stt.model.trim() !== ''
}

/** Build the transcription request for the user's gateway. */
export function buildSttRequest(
  gateway: GatewayConfig,
  model: string,
  audioBase64: string
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = gateway.baseUrl.trim().replace(/\/+$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (gateway.apiKey.trim() !== '') {
    if (gateway.authSchema === 'header' && gateway.authHeaderName.trim()) {
      headers[gateway.authHeaderName.trim()] = gateway.apiKey.trim()
    } else if (gateway.authSchema === 'none') {
      // keyless gateway — nothing to send
    } else {
      headers.authorization = `Bearer ${gateway.apiKey.trim()}`
    }
  }
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcribe this audio exactly what was spoken, in the same language. Output ONLY the transcription text — no commentary, no quotes.'
          },
          { type: 'input_audio', input_audio: { data: audioBase64, format: 'wav' } }
        ]
      }
    ]
  }
  return { url, headers, body }
}

/** Transcribe one WAV segment; empty string on failure (the call keeps flowing). */
export async function transcribeSegment(seg: SttSegment): Promise<string> {
  if (!seg.audioBase64) return ''
  const s = getSettings()
  if (!sttEnabled()) return ''
  try {
    const bytes = Buffer.from(seg.audioBase64, 'base64')
    if (bytes.length < 3_000) return '' // silence blip — not worth a round trip
    const { url, headers, body } = buildSttRequest(s.gateway, s.call.stt.model, seg.audioBase64)
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`STT model → ${res.status}`)
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = (json.choices?.[0]?.message?.content ?? '')
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .trim()
    return text
  } catch (error) {
    console.warn('[call] desktop STT failed:', String(error).slice(0, 180))
    return ''
  }
}
