import { readFile } from 'node:fs/promises'
import { listAttachmentsBySession } from './db/attachments'
import type { Attachment, ChatImage } from '../shared/types'

/**
 * Turn a user's uploaded IMAGE attachments into inline vision input, so the active
 * model literally sees the picture — "read an image the way Claude does".
 *
 * The adapters already expand {@link ChatMessage.images} into each provider's native
 * image block (OpenAI `image_url`, Anthropic `image`, Ollama `images`), but nothing
 * ever populated that field: an attached image was only copied into the Cowork working
 * folder as a file. This module reads THIS turn's image attachments off disk and returns
 * them as {@link ChatImage}s to attach to the latest user turn — in every mode, because
 * attaching an image means "look at this". The pure {@link toVisionImages} (byte reader
 * injected) is unit-tested; {@link readVisionImages} is the DB-backed wrapper.
 */

/** Cap on a single image's on-disk size for inline vision (bytes). A larger image is
 * skipped for vision (still reachable as a file in Cowork) so one huge upload can't
 * bloat the request past what a gateway will accept. */
export const MAX_VISION_BYTES = 8 * 1024 * 1024

/** Raster image mimes we send inline. SVG is excluded — it is markup, not a bitmap, and
 * vision endpoints reject it; a scanned PDF is handled separately (rasterized per page). */
export function isVisionImage(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(mime.trim())
}

/**
 * Pure: map attachment records to {@link ChatImage}s via an injected byte reader.
 * Non-image, oversized, or unreadable attachments are dropped — a bad image must never
 * sink the reply. Returns images in the attachments' original order.
 */
export async function toVisionImages(
  atts: Attachment[],
  readBytes: (path: string) => Promise<Buffer>
): Promise<ChatImage[]> {
  const out: ChatImage[] = []
  for (const a of atts) {
    if (!isVisionImage(a.mime)) continue
    if (a.size > MAX_VISION_BYTES) continue
    try {
      const buf = await readBytes(a.path)
      out.push({ mediaType: a.mime.trim().toLowerCase(), dataBase64: buf.toString('base64') })
    } catch {
      // Unreadable source bytes — skip this one, keep the rest.
    }
  }
  return out
}

/**
 * This turn's image attachments for a session, as inline vision images. "This turn's" =
 * the same selection {@link materializeAttachments} uses (rows bound to the sending user
 * message, plus still-pending rows whose bind IPC hasn't landed). Best-effort: returns
 * `[]` when there are none or on any DB/read error.
 */
export async function readVisionImages(
  sessionId: string,
  afterMsgId: string | null
): Promise<ChatImage[]> {
  let mine: Attachment[]
  try {
    const all = listAttachmentsBySession(sessionId)
    mine = all.filter((a) => a.messageId === afterMsgId || a.messageId === null)
  } catch {
    return []
  }
  if (mine.length === 0) return []
  return toVisionImages(mine, (p) => readFile(p))
}
