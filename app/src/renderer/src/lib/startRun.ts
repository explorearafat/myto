/**
 * startRun — the one way a turn begins, whoever asked for it.
 *
 * Sending a message is not just `send(text)`: a landing-page chat is an unsaved
 * draft, so the session row has to be created first or the turn has nowhere to
 * persist; a leading `/command` has to be expanded before the engine sees it; and a
 * still-unnamed session wants a title from its first prompt. The composer did all
 * of that inline, which was fine while the composer was the only sender. The
 * command palette is a second one, and a second copy of those four steps would
 * drift — a palette run that skipped `create()` would look like it worked and then
 * vanish on reload.
 *
 * So the sequence lives here and the composer calls it too. It reads the stores
 * directly (`getState()`) rather than taking them as arguments, because the caller
 * is often not a React component and the checks have to be against the *current*
 * state, not a render-time snapshot.
 */
import { useChatStore, type OutgoingAttachment } from '@renderer/store/useChatStore'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useAppStore } from '@renderer/store/useAppStore'
import { NO_SLASH_SOURCES, resolveSlashLive, type SlashSources } from './slashSources'

/** Why a send did not happen — so a surface can say which, instead of going quiet. */
export type StartRunBlocked = 'empty' | 'running' | 'needs-folder'

export interface StartRunResult {
  /** True when the turn actually went out. */
  sent: boolean
  /** The reason nothing was sent, or null when it was. */
  blocked: StartRunBlocked | null
  /**
   * The catalogs used to expand the line. Handed back so a caller that keeps them
   * in state can adopt a copy fetched on demand here.
   */
  sources: SlashSources
}

export interface StartRunOptions {
  /** Files already staged for this turn (the composer's pending list). */
  attachments?: OutgoingAttachment[]
  /** Slash catalogs the caller already holds; fetched here when empty. */
  sources?: SlashSources
}

/**
 * Send `raw` as a user turn. Trims it, refuses the three states where a send is
 * not possible, expands a slash line, makes sure a session exists to save into,
 * then sends and (fire-and-forget) titles the chat from the prompt.
 *
 * The bubble keeps the raw `/command …` the user typed; only the engine sees the
 * expansion, passed as the override third argument.
 */
export async function startRun(
  raw: string,
  opts: StartRunOptions = {}
): Promise<StartRunResult> {
  const text = raw.trim()
  const attachments = opts.attachments ?? []
  const sources = opts.sources ?? NO_SLASH_SOURCES

  if (useChatStore.getState().running) return { sent: false, blocked: 'running', sources }
  if (!text && attachments.length === 0) return { sent: false, blocked: 'empty', sources }
  // Code mode works against a folder on disk; without one chosen there is nothing
  // for the engine to read or write, so the composer blocks the send and says so.
  const app = useAppStore.getState()
  if (app.workMode === 'code' && !app.workspaceChosen) {
    return { sent: false, blocked: 'needs-folder', sources }
  }

  const expanded = await resolveSlashLive(text, sources)
  // A turn needs a persisted session to save into. On a fresh landing page the chat
  // is an unsaved draft (sessionId == null), so create the row now — lazily, on this
  // first send. This also covers the first-launch race, a send before boot()
  // resolves. create() files it under the rail's active project and stamps the root.
  if (useChatStore.getState().sessionId == null) {
    await useSessionStore.getState().create()
  }
  useChatStore
    .getState()
    .send(text, attachments, expanded.text !== text ? expanded.text : undefined)
  // No-ops once the session has a real title. See useSessionStore.autoName.
  void useSessionStore.getState().autoName(expanded.text)
  return { sent: true, blocked: null, sources: expanded.sources }
}
