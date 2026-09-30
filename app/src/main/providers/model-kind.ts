import type { ModelKind } from '../../shared/types'

/**
 * Decide whether a model produces text, images, or video (Feature B) — pure, so it is fully
 * unit-tested and never touches the network.
 *
 * The rule is deliberately conservative: an EXPLICIT user setting always wins, and when there
 * is none we infer from the model id but fall back to `'chat'` for anything we don't recognise.
 * That means every ordinary chat model (Claude, GPT, Llama, DeepSeek, …) stays `'chat'` and the
 * media-generation path is never taken by accident — the whole point, since Myto is
 * model-agnostic and must not reshape a normal turn.
 */

/** Substrings that mark a VIDEO-generation model id (checked first — a few contain "image"-ish words). */
const VIDEO_MARKERS = [
  'sora',
  'veo', // Google Veo
  'runway',
  'gen-3',
  'gen3',
  'kling',
  'pika',
  'luma',
  'dream-machine',
  'hunyuan-video',
  'wan-video',
  'wan2', // Alibaba Wan video
  'mochi',
  'ltx-video',
  'ltxv',
  'cogvideo',
  'animatediff',
  'text-to-video',
  'txt2video',
  't2v',
  'image-to-video',
  'img2video',
  'i2v',
  'video-gen',
  'videogen',
]

/** Substrings that mark an IMAGE-generation model id. */
const IMAGE_MARKERS = [
  'dall-e',
  'dalle',
  'gpt-image',
  'stable-diffusion',
  'stable-image',
  'sdxl',
  'sd3',
  'sd-3',
  'flux',
  'imagen', // Google Imagen
  'midjourney',
  'ideogram',
  'playground-v',
  'kandinsky',
  'kolors',
  'recraft',
  'firefly',
  'titan-image',
  'text-to-image',
  'txt2img',
  't2i',
  'image-gen',
  'imagegen',
  'image-generation',
]

/**
 * True when any marker in `markers` appears in the already-lowercased `id` **at a token
 * boundary** — the start of the id, or right after a non-alphanumeric separator (`-`, `.`, `/`,
 * `:`, `_`, space). Requiring a boundary stops a marker from matching glued inside a longer word:
 * the video marker `gen-3` must NOT fire inside the image id `imagen-3.0` (`…ima|gen-3…`), which
 * would otherwise misread Google Imagen as a video model. The right-hand side is left
 * unconstrained so a trailing suffix still matches (e.g. `dalle` in `dalle3`).
 */
function hasMarker(id: string, markers: readonly string[]): boolean {
  return markers.some((m) => {
    for (let from = 0; from <= id.length; ) {
      const at = id.indexOf(m, from)
      if (at < 0) return false
      const prev = at === 0 ? '' : id[at - 1]
      if (!prev || !/[a-z0-9]/.test(prev)) return true
      from = at + 1
    }
    return false
  })
}

/**
 * The kind of output to expect from `modelId`. `explicit` is the user's
 * {@link ProviderSettings.modelKind}; when it is `'image'` or `'video'` (or `'chat'`) it is
 * returned verbatim. Otherwise the id is sniffed: video markers first, then image markers,
 * then `'chat'` as the safe default.
 */
export function detectModelKind(modelId: string | undefined | null, explicit?: ModelKind): ModelKind {
  if (explicit === 'image' || explicit === 'video' || explicit === 'chat') return explicit
  const id = (modelId ?? '').toLowerCase().trim()
  if (!id) return 'chat'
  if (hasMarker(id, VIDEO_MARKERS)) return 'video'
  if (hasMarker(id, IMAGE_MARKERS)) return 'image'
  return 'chat'
}

/** Convenience: does this model produce media (image or video) rather than text? */
export function isMediaModel(modelId: string | undefined | null, explicit?: ModelKind): boolean {
  return detectModelKind(modelId, explicit) !== 'chat'
}
