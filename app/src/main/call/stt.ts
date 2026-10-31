/**
 * Desktop-side call speech recognition: POST a WebM/Opus segment of the
 * phone's mic (already streaming here over WebRTC) to any OpenAI-compatible
 * /audio/transcriptions endpoint (Groq's free whisper-large-v3-turbo works
 * well), returning the text. Disabled when no endpoint is configured — the
 * phone's on-device recognizer is always the primary path.
 */
import { getSettings } from '../settings'

export interface SttSegment {
  audioBase64: string
  mime: string
}

/** Is desktop-side STT configured? */
export function sttEnabled(): boolean {
  return getSettings().call.stt.endpoint.trim() !== ''
}

/** Transcribe one segment; empty string on failure (call keeps flowing). */
export async function transcribeSegment(seg: SttSegment): Promise<string> {
  const { endpoint, apiKey, model } = getSettings().call.stt
  if (endpoint.trim() === '' || !seg.audioBase64) return ''
  try {
    const bytes = Buffer.from(seg.audioBase64, 'base64')
    if (bytes.length < 2_000) return '' // silence/ blip — not worth a round trip
    const form = new FormData()
    const ext = seg.mime.includes('ogg') ? 'ogg' : seg.mime.includes('mp4') ? 'm4a' : 'webm'
    form.append('file', new Blob([bytes], { type: seg.mime }), `segment.${ext}`)
    form.append('model', model || 'whisper-large-v3-turbo')
    form.append('response_format', 'json')
    const res = await fetch(endpoint.trim(), {
      method: 'POST',
      headers: apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {},
      body: form,
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`STT endpoint → ${res.status}`)
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  } catch (error) {
    console.warn('[call] desktop STT failed:', String(error).slice(0, 160))
    return ''
  }
}
