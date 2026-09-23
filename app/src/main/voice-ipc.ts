import { ipcMain } from 'electron'
import { Buffer } from 'node:buffer'
import { IpcChannel } from '../shared/ipc'
import type { VoiceTranscribeInput, VoiceTranscribeResult } from '../shared/types'
import { getSettings } from './settings'
import { normaliseBaseUrl, toErrorMessage } from './providers/http'
import { openAiAdapter } from './providers/adapters'

/*
 * Voice IPC — server-side speech-to-text.
 *
 * The renderer records a short clip and sends it here; we forward it to the configured
 * gateway's OpenAI-compatible Whisper endpoint (`POST {base}/audio/transcriptions`) using
 * the same auth the chat calls use, and hand the recognised text back. The key never
 * leaves the main process. Any failure — no gateway configured, an endpoint that doesn't
 * do transcription, a network error — resolves to `{ ok: false }` with a reason, and the
 * renderer falls back to the browser's Web Speech API. So voice input works whether or not
 * the user's endpoint supports Whisper.
 */

/** Whisper is quick; a clip that hasn't transcribed in this long is treated as failed. */
const TRANSCRIBE_TIMEOUT_MS = 30_000

/** The transcription model requested. `whisper-1` is the broadly-supported default. */
const STT_MODEL = 'whisper-1'

/** A file extension for the upload part, from the clip's MIME type (Whisper reads it). */
function extForMime(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  return 'webm'
}

export async function transcribeAudio(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult> {
  const settings = getSettings()
  // Whisper transcription only makes sense against an OpenAI-compatible gateway.
  if (settings.activeProvider !== 'gateway') return { ok: false, error: 'no-gateway' }
  const gateway = settings.gateway
  const base = normaliseBaseUrl(gateway.baseUrl)
  if (!base) return { ok: false, error: 'no-gateway' }

  const data = typeof input?.data === 'string' ? input.data : ''
  if (!data) return { ok: false, error: 'no-audio' }
  const mime = typeof input?.mime === 'string' && input.mime ? input.mime : 'audio/webm'

  const bytes = Buffer.from(data, 'base64')
  // Blob/FormData/fetch are all global in Electron's Node runtime; use them directly so
  // the multipart boundary + content-type are set for us (httpFetch would JSON-encode this).
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), `audio.${extForMime(mime)}`)
  form.append('model', STT_MODEL)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: openAiAdapter.authHeaders(gateway),
      body: form,
      signal: controller.signal
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
    }
    const json = (await res.json().catch(() => null)) as { text?: string } | null
    const text = (json?.text ?? '').trim()
    return text ? { ok: true, text } : { ok: false, error: 'empty' }
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) }
  } finally {
    clearTimeout(timer)
  }
}

export function registerVoiceIpc(): void {
  ipcMain.handle(IpcChannel.VoiceTranscribe, (_event, input: VoiceTranscribeInput) =>
    transcribeAudio(input)
  )
}
