import type { ChatImage, ChatMessage } from '../../shared/types'

/**
 * The Assistant's eyes: put screenshots in front of a vision-capable model and
 * get structured reads back. The provider layer already expands
 * {@link ChatMessage.images} into each backend's native image blocks, so this
 * module is deliberately thin — the value is in the strict question framing and
 * the honest failure mode when the configured model can't see.
 */

const VISION_HINT = /gpt-4o|gpt-4\.|gpt-5|claude|gemini|glm-4v|glm-5|qwen.*vl|llava|pixtral|vision|vl-|multimodal/i

/** Heuristic: does this model id look vision-capable? Used only for a heads-up —
 * the real answer comes from the endpoint itself. */
export function isLikelyVisionModel(modelId: string): boolean {
  return VISION_HINT.test(modelId)
}

export interface ScreenRead {
  ok: boolean
  text: string
  /** 'no-vision' = the model refused/errored in a way consistent with no image input. */
  why?: 'no-vision' | 'error'
}

/** Words endpoints typically emit when a text-only model meets an image. */
const NO_VISION_RE = /image|vision|multimodal|not support|unsupported|cannot view|can't view|no image|invalid content/i

/**
 * Ask the model to read screenshots and answer `question`. `question` should
 * demand a strict format — the callers parse the reply. Resolves a readable
 * failure (never throws) so a wrong model choice degrades to advice instead of
 * a crash.
 */
export async function readScreen(
  provider: { getCompletion: (m: string, msgs: ChatMessage[]) => Promise<string> },
  modelId: string,
  images: ChatImage[],
  question: string
): Promise<ScreenRead> {
  if (images.length === 0) return { ok: false, text: 'no screenshot was captured', why: 'error' }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are the eyes of the user\'s desktop assistant. Describe ONLY what the screenshots show, concretely: app names, window titles, message texts (verbatim), button labels and their positions. Never guess at what might be there.'
    },
    { role: 'user', content: question, images }
  ]
  try {
    const text = await provider.getCompletion(modelId, messages)
    if (!text.trim()) return { ok: false, text: 'the model returned nothing for the screenshot', why: 'error' }
    return { ok: true, text: text.trim() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const noVision = NO_VISION_RE.test(message) || !isLikelyVisionModel(modelId)
    return {
      ok: false,
      text: noVision
        ? `the model "${modelId}" could not read the screen — set a vision-capable model (e.g. gpt-4o, claude, gemini) with "myto config --model …" or in Settings`
        : `screen read failed: ${message}`,
      why: noVision ? 'no-vision' : 'error'
    }
  }
}

/** Parse `FROM:`/`ME:` chat lines out of a screen read — the tone pipeline's input. */
export function parseChatLines(read: string): Array<{ from: 'me' | 'them'; text: string }> {
  const out: Array<{ from: 'me' | 'them'; text: string }> = []
  for (const raw of read.split(/\r?\n/)) {
    const m = /^\s*(?:\d+[.)]\s*)?(THEM|ME)\s*[:：]\s*(.+)$/.exec(raw.trim())
    if (m) out.push({ from: m[1] === 'ME' ? 'me' : 'them', text: m[2].trim() })
  }
  return out
}
