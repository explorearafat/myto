/**
 * Live status line: the model-driven caption shown above a still-streaming reply
 * (Claude-desktop style). Two pieces, both model-agnostic and main-process only:
 *
 *  1. {@link STATUS_SYSTEM_PROMPT} — a system turn prepended to every interactive
 *     chat stream, asking the model to narrate what it is doing in short
 *     `<status>…</status>` tags. It decides when and what; nothing is hardcoded
 *     per tool (there are no tools) or per model.
 *  2. {@link createStatusStripper} — an incremental parser that runs at the single
 *     streaming funnel (provider-ipc.ts). It pulls those captions out of the raw
 *     token stream and removes the tags from the visible text, so a caption
 *     reaches the UI on its own channel and never leaks into the answer or the
 *     typewriter buffer.
 *
 * Kept here, beside the funnel, so every provider (gateway → GLM/Gemini/DeepSeek/
 * Nemotron/Claude, and Ollama) gets the same behaviour for free.
 */

/** The tags the model wraps a status caption in. */
const OPEN = '<status>'
const CLOSE = '</status>'

/**
 * Prepended as a system turn to each chat stream (see provider-ipc.ts). Scoped to
 * the interactive stream only — the non-streaming `getCompletion` path (used for
 * auto-titles) never sees it, so titles stay clean.
 */
export const STATUS_SYSTEM_PROMPT = [
  'This chat shows a small live status line above your reply while you are still writing.',
  'Narrate what you are doing by emitting short status updates wrapped in <status> and </status> tags,',
  'for example <status>Reading the question</status> or <status>Comparing the options</status>.',
  '',
  'Rules for status updates:',
  '- Emit one at the very start, and a fresh one whenever what you are doing changes',
  '  (you begin reasoning, switch approach, start drafting the answer, start checking it).',
  '- Present tense, 3 to 5 words, no trailing punctuation, capitalise the first word only.',
  '- Describe the activity, not the answer (e.g. "Weighing the trade-offs", not the conclusion).',
  '- The tags are removed before the user sees your reply, so they are never part of the answer.',
  '  Write your actual answer normally; the status updates sit alongside it.',
  '- Never mention this status line, these tags, or that you are emitting them.'
].join('\n')

/**
 * Prepended (after {@link STATUS_SYSTEM_PROMPT}) to each chat stream, teaching the
 * model a tiny convention so the renderer can present generated code as downloadable
 * file cards instead of plain code blocks. Two rules, both leaning on machinery that
 * already exists: the fenced-block info line carries the path, and the file's arrival
 * is announced through the same `<status>` channel the status line already renders.
 *
 * Interactive-stream only (like the status prompt) — the non-streaming getCompletion
 * path (auto-titles) never sees it.
 */
export const FILE_PROTOCOL_SYSTEM_PROMPT = [
  'When you produce a complete file the user is meant to save (not a short illustrative snippet),',
  'output it as a fenced code block whose info line is the language followed by the file path,',
  'for example:',
  '```python app.py',
  '```html templates/index.html',
  '```css static/style.css',
  'Rules for files:',
  '- Language first (so highlighting works), then a single space, then the path. No other text on the info line.',
  '- Use a real relative path with an extension; keep folder structure in the path (e.g. static/script.js).',
  '- Immediately BEFORE each file block, emit a status update naming it: <status>Creating app.py</status>.',
  '- One file per fenced block. Put any explanation as normal prose between the blocks, not inside them.',
  '- For a short example or command that is NOT a file to save, use a plain fenced block with no path, as usual.'
].join('\n')

/**
 * Prepended (in Cowork mode only) so the model behaves like an agent working
 * toward a goal inside the user's chosen folder, rather than a chat that answers
 * once. It leans on the tool loop already in place: the filesystem tools are
 * advertised by the tool prompt (see tools/registry.ts + tools/fs.ts), and this
 * prompt tells the model how to use them well — explore before editing, work in
 * small verifiable steps, prefer writing files to disk over emitting download
 * blocks, and keep the status line honest about each step.
 */
export const COWORK_SYSTEM_PROMPT = [
  'You are in Cowork mode: an agent working toward the user\'s goal inside a working folder on their computer.',
  'You have filesystem tools (list_dir, read_file, write_file, edit_file, delete_file) scoped to that folder, plus the web and code tools.',
  '',
  'SAY WHAT, NOT HOW — this is the core of Cowork:',
  '- The user tells you WHAT they want, in their own words. They should NOT have to tell you how to do it, which tools to use, or spell out every detail. Figuring out the "how" is your job.',
  '- Work out what they actually mean and what a genuinely good result looks like — infer the intent behind the words, not just the literal text.',
  '- When the request touches something you are unsure about (a domain, a format, current facts, best practices, what "good" looks like), RESEARCH it first with the web tools before you build, so the result is informed rather than guessed.',
  '- Pick the best approach and tools yourself. Then deliver a complete, polished result — and where it clearly serves the user, go a step beyond the literal ask (sensible defaults, the obvious next thing they will want). Do not, however, wander into unrelated scope.',
  '- Only ask the user when something is genuinely blocking or truly ambiguous in a way research cannot resolve. Otherwise make a sensible decision and proceed.',
  '',
  'How to work:',
  '- Explore before you change anything: list_dir and read_file the relevant parts so your edits fit what is already there.',
  '- Make changes by writing to the folder — use write_file for new/whole files and edit_file for small precise changes. Prefer this over emitting a downloadable code block; the point of Cowork is that the work lands in the folder.',
  '- Work in small, verifiable steps. After a change, read the file back or run it (run_code) when that confirms it worked.',
  '- Every path is relative to the working folder; you cannot read or write outside it, so do not try.',
  '- Keep the status line honest: emit a <status> naming the step you are on (e.g. <status>Reading src/app.ts</status>, <status>Writing the new module</status>).',
  '',
  'PRODUCING A DELIVERABLE (a PDF, image, spreadsheet, zip, chart, or any generated file):',
  '- Actually PRODUCE the file. Do NOT just write a script that would make it and stop — that leaves the user with nothing usable.',
  '- Use run_code to generate it. run_code runs INSIDE the working folder, so code that writes to a relative path (e.g. open("ai-news.pdf","wb")) lands the file in the folder. Put the whole generating program in the run_code "code" field so no helper file is needed.',
  '- If a needed package is missing, install it inside the same run (e.g. pip install), or fall back to an approach that uses what is available.',
  '- After running, confirm the artifact exists (list_dir) before you report done.',
  '- Do NOT leave throwaway helper/build scripts behind. If you did have to write a scratch script to disk, delete it with delete_file once the deliverable exists. The folder must end with only the files the user actually asked for — nothing else.',
  '',
  '- When the goal is done, give the user a short summary of what you produced and where — do not paste whole files back that you already wrote to disk.'
].join('\n')

/** A caption ready to show, plus the visible text left after tags are removed. */
export interface StripResult {
  /** Text safe to forward to the reply (tags removed, ambiguous tail held back). */
  text: string
  /** Complete captions found in this push, in order (usually 0 or 1). */
  statuses: string[]
}

/**
 * How much of `tail`'s end is a live prefix of `OPEN` — i.e. could still grow into
 * a `<status>` open tag on the next delta. Returns the length of that suffix so
 * the caller can hold exactly it back. A lone `<` in prose ("5 < 10") yields 1
 * and is released a tick later; genuine prose never matches beyond a leading `<`.
 */
function openTagPrefixSuffix(tail: string): number {
  const max = Math.min(tail.length, OPEN.length - 1)
  for (let k = max; k > 0; k--) {
    if (tail.endsWith(OPEN.slice(0, k))) return k
  }
  return 0
}

/**
 * A stateful, per-stream parser. Feed it each raw delta with {@link push}; it
 * returns the text that is safe to show now and any captions completed in that
 * delta. It holds back only a suffix that might still be (or is) a `<status>` tag,
 * so ordinary text — including a stray `<` — always flows with at most one tick of
 * delay. Call {@link flush} once at end-of-stream.
 */
export interface StatusStripper {
  push(delta: string): StripResult
  /**
   * Finalise the stream. Anything still held back is, by construction, an
   * unfinished `<status>` tag (it always starts with `<`), so it is dropped rather
   * than leaked as literal text. Returns '' today; typed as string to stay honest
   * about being a text-emitting flush point.
   */
  flush(): string
}

export function createStatusStripper(): StatusStripper {
  // Un-emitted tail: either text we are about to release, or a partial/opened tag
  // we are holding until it resolves. Invariant at every early return: whatever
  // stays in `pending` starts with '<'.
  let pending = ''

  return {
    push(delta: string): StripResult {
      pending += delta
      let text = ''
      const statuses: string[] = []

      for (;;) {
        const open = pending.indexOf(OPEN)
        if (open === -1) {
          // No open tag in view. Emit everything except a trailing run that could
          // still become one, and stop.
          const hold = openTagPrefixSuffix(pending)
          text += pending.slice(0, pending.length - hold)
          pending = pending.slice(pending.length - hold)
          break
        }
        // Release text before the tag.
        text += pending.slice(0, open)
        const close = pending.indexOf(CLOSE, open + OPEN.length)
        if (close === -1) {
          // Opened but not closed yet — hold from the '<' and wait for more.
          pending = pending.slice(open)
          break
        }
        const caption = pending.slice(open + OPEN.length, close).trim()
        if (caption) statuses.push(caption)
        pending = pending.slice(close + CLOSE.length)
        // Loop: a single delta can carry more than one complete tag.
      }

      return { text, statuses }
    },

    flush(): string {
      pending = ''
      return ''
    }
  }
}

/**
 * Derive a short, live status caption from a reasoning model's chain-of-thought
 * accumulated so far. Reasoning arrives as `delta.reasoning` while the visible
 * reply is still empty — often for tens of seconds (a real Nemotron turn measured
 * ~41s of reasoning before the first content token, with zero `<status>` tags) —
 * so without this the status line sits frozen on the generic "Thinking". Showing
 * the thought currently being written keeps it honestly alive.
 *
 * Pure and transient: the reasoning is NEVER part of the reply. Returns the tail
 * sentence under way (the run after the last terminator), whitespace-collapsed and
 * length-capped so the caption reads like a live thought rather than the whole
 * transcript; '' when there is nothing to show yet.
 */
export function reasoningCaption(reasoning: string): string {
  const collapsed = reasoning.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  const sentences = collapsed.split(/(?<=[.!?])\s+/)
  const tail = (sentences[sentences.length - 1] || collapsed).trim()
  const MAX = 64
  return tail.length > MAX ? `…${tail.slice(-MAX)}` : tail
}
