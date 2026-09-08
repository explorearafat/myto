/**
 * threadCards — which tool cards the CHAT thread shows.
 *
 * One rule, and it is about reads. A single question ("what does this app do?")
 * can cost a dozen of them, and a dozen
 * `⌕ Read tailwind.config.js · 105 lines` rows bury the answer they were taken
 * for. The user's verdict was that what Sylor read is not something they need
 * shown at all: while it happens the status row already says
 * `Reading tailwind.config.js`, and once the answer is written nothing about the
 * reading needs to stay on screen.
 *
 * A read that FAILED does stay. That one is not noise — it is work that did not
 * happen, and a file that wasn't there is often the reason an answer is thinner
 * than it looks; hiding it would leave the transcript telling a story the run
 * didn't have.
 *
 * Nothing is lost either way. Every read is still stamped into the Run Log canvas
 * with its timing and its full output, and still persisted to `tool_ops`, so what
 * a decision was based on stays one click away and survives a reload. This lives
 * in `lib/` rather than in `ChatPanel.tsx` because that file exports only
 * components, and a second kind of export there costs a react-refresh warning.
 */
import type { ToolCardUI } from '@renderer/store/useChatStore'

/** The cards a turn renders in the thread: everything except a read that went fine. */
export function threadCards(cards: readonly ToolCardUI[]): ToolCardUI[] {
  return cards.filter((c) => {
    if (c.proposal.kind !== 'read') return true
    // The result's kind is checked, not just its `ok`, because a read still in
    // flight has no result yet — and a row that appears only to disappear once the
    // file comes back is worse than never showing it.
    return c.result?.kind === 'read' && !c.result.ok
  })
}
