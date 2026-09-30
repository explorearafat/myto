import type { PreviewTarget } from '../../shared/types'

/**
 * Build-complete visual self-review (Cowork) — the PURE half.
 *
 * When a Cowork run has built something viewable (a page, a dev server), the loop takes ONE
 * screenshot of its preview and hands it back so the model can catch layout/style/visual bugs a
 * text-only view never surfaces, then fixes them and lets the verify gate prove they typecheck
 * green. Everything here is deterministic and Electron-free so it is fully unit-tested; the IO
 * (stat the entry files, read the running dev-server URL, drive the offscreen capturer) lives in
 * provider-ipc.ts + preview-capture-runtime.ts.
 */

/**
 * How many times a single run may run the screenshot self-review. ONE: the whole point of the
 * feature is a decisive finish — a build completes, it is looked at once, fixed if need be, and
 * verified. Firing it more than once would risk turning "done" into an endless polish loop, which
 * is the very "never stops" behaviour this is meant to end.
 */
export const MAX_VISUAL_REVIEWS = 1

/**
 * Where a finished web build's entry page tends to sit, in priority order — the working-folder
 * root first, then the usual build-output dirs. Used only as the LAST resort, when the model
 * never previewed anything and no dev server is running, to still show and screenshot the result.
 */
export const PREVIEW_ENTRY_CANDIDATES = [
  'index.html',
  'dist/index.html',
  'build/index.html',
  'public/index.html',
  'out/index.html',
  'site/index.html'
] as const

/** A workspace-relative entry file that exists on disk, with its resolved `file://` URL. */
export interface ExistingEntry {
  rel: string
  url: string
}

/**
 * Choose what to screenshot at build-complete, PURE. Priority:
 *  1. `lastPreview` — what the model itself already opened in the pane this run (most intentional).
 *  2. `runningServerUrl` — a dev server it started and left running.
 *  3. `existingEntry` — a built HTML entry found on disk (the fallback that lets a run that never
 *     called `preview`/`run_dev_server` still be reviewed).
 * Returns null when none apply — a non-web deliverable (a script, a document) has nothing to look
 * at, so the review is skipped and the run finishes as it did before.
 */
export function pickReviewTarget(opts: {
  lastPreview: PreviewTarget | null
  runningServerUrl: string | null
  existingEntry: ExistingEntry | null
}): PreviewTarget | null {
  const { lastPreview, runningServerUrl, existingEntry } = opts
  if (lastPreview) return lastPreview
  if (runningServerUrl && runningServerUrl.trim()) {
    return { kind: 'url', url: runningServerUrl.trim(), title: runningServerUrl.trim() }
  }
  if (existingEntry) return { kind: 'file', url: existingEntry.url, title: existingEntry.rel }
  return null
}

/**
 * The user turn that rides back with the screenshot, PURE. It tells the model the picture IS the
 * rendered preview (not a description to imagine), names the concrete visual faults to look for,
 * and gives a clear two-way exit: fix with tools, or confirm and stop — so the run terminates
 * rather than looping. `goalReminder` keeps the original task in view (same prefix the other
 * gates use); `title` labels which preview it is.
 */
export function visualReviewInstruction(goalReminder: string, title: string): string {
  return (
    `${goalReminder}The project is built and its preview (${title}) is now open. ` +
    'Attached is a SCREENSHOT of that preview exactly as it renders right now — treat it as the ' +
    'ground truth for how the result looks, not your memory of the code.\n\n' +
    'Inspect it closely for VISUAL and LAYOUT problems: broken, overlapping or cramped layout; ' +
    'unstyled, invisible or clipped text; elements off-screen or misaligned; missing images or ' +
    'icons; wrong colours or poor contrast; and any error overlay, stack trace or blank page.\n\n' +
    'If you find ANY issue, fix it now with edit_file/write_file and keep going one tool call at a ' +
    'time. If — and only if — the preview looks correct and complete, say so in one line and stop; ' +
    'the build will then be verified.'
  )
}
