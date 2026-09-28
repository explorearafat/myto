import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { PreviewTarget } from '../../shared/types'
import { resolveInWorkspace } from './fs'
import type { ToolDef, ToolGate } from './registry'

/**
 * The `preview` tool: Myto's own preview pane, in Cowork.
 *
 * This is what lets Myto SHOW its work while it goes — a plan it wrote, an HTML
 * page it built, a PDF/chart/image it generated, or a localhost dev server it
 * started — in a browser pane beside the chat, self-controlled, without the user
 * having to open anything. It is read-only display: it opens a view, it never
 * changes the folder, so it needs no approval in any permission tier.
 *
 * Two kinds of target:
 *  - a working-folder file (the common case): a relative path, resolved through the
 *    same {@link resolveInWorkspace} sandbox the filesystem tools use and turned
 *    into a `file://` URL so it can't point outside the folder.
 *  - a web URL: an http(s) address (typically a localhost dev server Myto just
 *    started, or a page it wants the user to look at).
 *
 * The actual pane is renderer-side (an isolated `<webview>`); this tool just emits
 * the {@link PreviewTarget} through {@link ToolContext.onPreview}, which the stream
 * loop forwards to the renderer as a preview chunk.
 */

/** Available in the agentic modes (Cowork and Research); a file preview checks for a root at run time. */
function previewAvailable(gate: ToolGate): boolean {
  return gate.mode === 'cowork' || gate.mode === 'research'
}

/** Read a trimmed string field out of a tool input, or null. */
function readField(input: unknown, key: string): string | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export const previewTool: ToolDef = {
  name: 'preview',
  description:
    'Show something in your own preview pane beside the chat: a file from the working folder (an HTML page, a PDF, an image, a chart) by "path", or a web page (e.g. a localhost dev server) by "url". Read-only display — it opens a view, it does not change anything.',
  usage: '{"path": "report.html"}  or  {"url": "http://localhost:5173"}',
  available: previewAvailable,
  async run(input, ctx) {
    if (!ctx.onPreview) {
      // No pane to drive (outside the streaming loop). Nothing to show; say so
      // plainly rather than pretending it opened.
      return 'The preview pane is not available in this context.'
    }

    const rawUrl = readField(input, 'url')
    const rawPath = readField(input, 'path')

    // A web URL: only http(s) is loadable in the pane.
    if (rawUrl) {
      let parsed: URL
      try {
        parsed = new URL(rawUrl)
      } catch {
        return `preview: "${rawUrl}" is not a valid URL.`
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `preview: only http(s) URLs (or a working-folder "path") can be shown; got "${parsed.protocol}".`
      }
      const target: PreviewTarget = { kind: 'url', url: parsed.toString(), title: rawUrl }
      ctx.onPreview(target)
      return `Showing ${rawUrl} in the preview pane.`
    }

    // A working-folder file: sandbox it, confirm it exists, and open it as file://.
    if (rawPath) {
      const abs = ctx.workspaceDir ? resolveInWorkspace(ctx.workspaceDir, rawPath) : null
      if (!abs) {
        return ctx.workspaceDir
          ? `preview: "${rawPath}" is outside the working folder and was refused.`
          : 'preview: no working folder is set, so a file path cannot be resolved. Pick a folder or preview a "url" instead.'
      }
      try {
        const info = await stat(abs)
        if (!info.isFile()) return `preview: "${rawPath}" is not a file.`
      } catch {
        return `preview: "${rawPath}" does not exist yet — create it first, then preview it.`
      }
      const target: PreviewTarget = { kind: 'file', url: pathToFileURL(abs).toString(), title: rawPath }
      ctx.onPreview(target)
      return `Showing ${rawPath} in the preview pane.`
    }

    return 'preview needs a "path" (a file in the working folder) or a "url" (an http(s) page), e.g. {"path": "report.html"}.'
  }
}
