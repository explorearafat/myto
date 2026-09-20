/**
 * Prompt DNA Compiler
 * Transforms visual blocks into a structured, well-formatted prompt.
 *
 * The compiler is pure and deterministic: the same blocks always produce the
 * same prompt. It lives in `shared` so both the renderer (live preview) and any
 * future main-process caller compile identically.
 */

import type { PromptBlock, PromptBlockType } from './types/prompt-builder'

/**
 * Section headers written into the compiled prompt, per block type. Chosen to
 * read naturally to a model without being verbose — a capable model treats these
 * as soft structure, not rigid commands.
 */
const SECTION_HEADERS: Record<PromptBlockType, string> = {
  context: 'Context',
  task: 'Task',
  constraint: 'Requirements',
  format: 'Output format',
  example: 'Example'
}

/**
 * Compile an ordered set of blocks into a single prompt string.
 *
 * Only enabled blocks with non-empty content contribute. Blocks are emitted in
 * their `order`, each under a bold markdown header. An empty result (no usable
 * blocks) returns '' so the caller can fall back to plain text mode.
 */
export function compilePrompt(blocks: PromptBlock[]): string {
  const usable = blocks
    .filter((b) => b.enabled && b.content.trim().length > 0)
    .sort((a, b) => a.order - b.order)

  if (usable.length === 0) return ''

  const sections = usable.map((block) => {
    const header = SECTION_HEADERS[block.type]
    const content = block.content.trim()
    return `**${header}:**\n${content}`
  })

  return sections.join('\n\n')
}

/**
 * A lightweight preview of what the compiled prompt will look like, truncated for
 * display in a small preview pane. Returns the full text when short.
 */
export function previewPrompt(blocks: PromptBlock[], maxLength = 280): string {
  const compiled = compilePrompt(blocks)
  if (compiled.length <= maxLength) return compiled
  return `${compiled.slice(0, maxLength)}…`
}

/**
 * Count how many blocks will actually contribute to the prompt. Used to show a
 * live "3 blocks active" hint and to decide whether the Send button is enabled.
 */
export function activeBlockCount(blocks: PromptBlock[]): number {
  return blocks.filter((b) => b.enabled && b.content.trim().length > 0).length
}

/**
 * Whether the canvas has anything worth sending. Mirrors {@link activeBlockCount}
 * > 0 but reads clearly at call sites.
 */
export function hasContent(blocks: PromptBlock[]): boolean {
  return activeBlockCount(blocks) > 0
}
