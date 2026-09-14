import { createHash } from 'node:crypto'
import type { Evidence, ReadResult, ToolProposal, ToolResult } from '../../shared/types'
import { contextManager } from '../context/manager'

/**
 * In-run read deduplication (Problem 1: "it reads the SAME file over and over").
 *
 * Every read the agent makes echoes the file's (bounded) content into the next
 * turn, and the whole conversation is re-sent to the model every step — so a
 * second identical read of an unchanged file costs a wasted disk hit AND a second
 * full copy of that content in the context window, for zero new information. This
 * module lets {@link executeTool} answer a repeat `read_file` from a short note
 * instead, while staying correct: a write or command that could have changed the
 * file drops it from the cache, and a size/mtime change forces a fresh read.
 *
 * The per-run cache is a `Map<key, ReadCacheEntry>` living on the run handle (so
 * it's cleared when the run ends). `key` identifies a specific read window; the
 * entry carries the file's `size:mtime` at read time — the freshness guard — and
 * whether the read was COMPLETE.
 *
 * These helpers are kept out of `engine.ts` (and its Electron-heavy import chain)
 * so they can be unit-tested directly against the real {@link contextManager}.
 */

/** What a served read is remembered by, per window key. */
export interface ReadCacheEntry {
  /** The file's `size:mtime` when we served it — the freshness guard. */
  stamp: string
  /**
   * True when the read reached the end of the file. Only a complete read can
   * answer for a window it never asked for (see {@link servedFromReadCache}): if
   * the file was clipped, lines past the cut genuinely were never shown, and a
   * later `offset` into them is a real continuation, not a repeat.
   */
  complete: boolean
}

/** `size:mtime` stamp string for a stat result — the cache's freshness token. */
function stampOf(stat: { size: number; mtime: number }): string {
  return `${stat.size}:${stat.mtime}`
}

/**
 * Cache key for a read: the active root + the path as the model spelled it + the
 * line window, JSON-encoded so no separator char can ever collide (a path may
 * contain spaces, quotes, anything but a NUL). The root is part of the key so a
 * worktree subagent reading `foo.ts` never aliases the lead reading a different
 * `foo.ts`.
 */
export function readCacheKey(root: string, path: string, offset?: number, limit?: number): string {
  return JSON.stringify([root, path, offset ?? null, limit ?? null])
}

/**
 * Prefix that every {@link readCacheKey} for a given (root, path) starts with,
 * regardless of the line window — used to evict all cached windows of a file on
 * write. JSON's closing quote after the path makes the boundary exact, so
 * `foo.ts` never matches `foo.ts.bak`.
 */
function pathKeyPrefix(root: string, path: string): string {
  const withPath = JSON.stringify([root, path])
  return `${withPath.slice(0, -1)},` // drop the trailing "]" and reopen the array
}

/**
 * The fresh entry for `key`, or null when there is none — evicting a stale one on
 * the way out so it can never mislead a later check. "Stale" covers a file that
 * changed size/mtime and one that vanished entirely.
 */
function freshEntry(
  cache: Map<string, ReadCacheEntry>,
  key: string,
  path: string
): ReadCacheEntry | null {
  const seen = cache.get(key)
  if (seen === undefined) return null
  const stat = contextManager.fileStamp(path)
  if (!stat || stampOf(stat) !== seen.stamp) {
    cache.delete(key)
    return null
  }
  return seen
}

/**
 * If this `read_file` was already answered this run and the file is unchanged on
 * disk since, returns a short "already read" note to hand back INSTEAD of a second
 * disk read + a second full-content injection. Returns null on the first read, a
 * changed/vanished file (the stale entry is evicted so the caller re-reads), or any
 * non-`read_file` op. Media reads are never cached (they carry image bytes for a
 * vision turn), so only prior TEXT reads ever reach this path.
 *
 * Two ways to hit. The exact window is the obvious one. The load-bearing one is the
 * WHOLE-FILE entry answering for a windowed request: `planReadWindow` makes the
 * first read of any path complete, so "read `Navbar.tsx` lines 1–70" after
 * `Navbar.tsx` has been read in full is asking for text that is already in the
 * conversation verbatim — the third read of the same file in the report that
 * prompted this. Only a `complete` whole-file read may subsume like that; a clipped
 * one leaves real lines unseen, and an `offset` into them is a continuation.
 */
export function servedFromReadCache(
  cache: Map<string, ReadCacheEntry>,
  proposal: ToolProposal
): ReadResult | null {
  if (proposal.kind !== 'read' || proposal.op !== 'read_file') return null
  const root = contextManager.getRoot()
  const exact = readCacheKey(root, proposal.path, proposal.offset, proposal.limit)
  const whole = readCacheKey(root, proposal.path, undefined, undefined)
  const served =
    freshEntry(cache, exact, proposal.path) !== null ||
    (whole !== exact && freshEntry(cache, whole, proposal.path)?.complete === true)
  if (!served) return null

  const summary = contextManager.indexSummaryFor(proposal.path)
  const structure = summary ? ` Structural summary: ${summary}` : ''
  return {
    id: proposal.id,
    kind: 'read',
    ok: true,
    output:
      `You already read \`${proposal.path}\` earlier in this turn and nothing has changed it ` +
      'since, so its full text is still above in this conversation — scroll up to it rather ' +
      `than asking again.${structure}`,
    truncated: false,
    summary: 'already read (unchanged)'
  }
}

/**
 * True when this run has already read `path` in FULL and the file is unchanged
 * since — the question {@link planReadWindow} needs in order to tell a keyhole
 * (first look at a file, must be whole) from a continuation (walking through a file
 * too big for one read).
 */
export function hasCompleteRead(cache: Map<string, ReadCacheEntry>, path: string): boolean {
  const key = readCacheKey(contextManager.getRoot(), path, undefined, undefined)
  return freshEntry(cache, key, path)?.complete === true
}

/**
 * Updates the per-run read cache and the persistent project index after a tool
 * actually ran:
 *  - a successful text read is remembered (window → stamp + whether it was
 *    complete) and fed to the index;
 *  - a successful write evicts every cached window of that path (a read-after-write
 *    must return fresh bytes) and refreshes the file's index summary;
 *  - any command clears the whole cache — a command can touch arbitrary files, so
 *    nothing read before it can be trusted as unchanged.
 */
export function updateReadCache(
  cache: Map<string, ReadCacheEntry>,
  proposal: ToolProposal,
  result: ToolResult
): void {
  if (
    proposal.kind === 'read' &&
    proposal.op === 'read_file' &&
    result.kind === 'read' &&
    result.ok &&
    !result.media
  ) {
    const stamp = contextManager.fileStamp(proposal.path)
    if (stamp) {
      const key = readCacheKey(
        contextManager.getRoot(),
        proposal.path,
        proposal.offset,
        proposal.limit
      )
      // `truncated` is the reader's own word for "there is more file past what I
      // just gave you", so its negation is exactly what `complete` means.
      cache.set(key, { stamp: stampOf(stamp), complete: !result.truncated })
    }
    contextManager.noteRead(proposal.path)
    return
  }

  if (proposal.kind === 'write_file' && result.kind === 'write_file' && result.ok) {
    const prefix = pathKeyPrefix(contextManager.getRoot(), proposal.path)
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
    contextManager.noteWrite(proposal.path, proposal.newContent)
    return
  }

  if (proposal.kind === 'run_command') {
    cache.clear()
  }
}

/**
 * Longest excerpt a single {@link Evidence} record carries. Bounded so one big
 * file the explorer read can't dominate a downstream agent's prompt; the
 * blackboard applies a second, section-wide cap on top of this (see
 * `sharedContext.render`).
 */
export const EVIDENCE_EXCERPT_MAX = 1_200

/**
 * Turns a successful `read_file` into a bounded {@link Evidence} record — the
 * concrete excerpt a downstream agent inherits so it builds on the exact text
 * instead of re-reading (Principle 3). Returns null for anything that isn't a
 * usable text read (a listing/search, a media read, a failure, an empty file),
 * so only real file contents ever become evidence.
 *
 * The `range` is anchored to real 1-based lines: a windowed read starts at its
 * `offset`, a whole-file read at line 1. It reflects the full span the reader
 * SAW (before the excerpt itself is clipped for size), so a consumer can cite
 * "lines 40–120" even when only the first 1 200 chars are shown. The `sha` is a
 * short hash of that full seen content — the anchor that lets the excerpt be
 * trusted as current.
 */
export function readEvidence(proposal: ToolProposal, result: ToolResult): Evidence | null {
  if (proposal.kind !== 'read' || proposal.op !== 'read_file') return null
  if (result.kind !== 'read' || !result.ok || result.media) return null
  const content = (result as ReadResult).output ?? ''
  if (!content.trim()) return null
  const start = proposal.offset && proposal.offset > 0 ? proposal.offset : 1
  const lines = content.split('\n').length
  const sha = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const excerpt =
    content.length > EVIDENCE_EXCERPT_MAX ? `${content.slice(0, EVIDENCE_EXCERPT_MAX)}…` : content
  return { path: proposal.path, range: [start, start + lines - 1], sha, excerpt }
}

/**
 * Appends `ev` to a node's evidence ledger, de-duplicated by path + line range so
 * a file read twice (or re-read after a windowed peek at the same span) is kept
 * once, newest wins. Caps the ledger at {@link MAX_EVIDENCE_PER_NODE} records so a
 * long exploration can't grow it without bound — the freshest excerpts are the
 * ones a downstream agent needs.
 */
export function recordEvidence(ledger: Evidence[], ev: Evidence): void {
  const sameRange = (a?: [number, number], b?: [number, number]): boolean =>
    a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1])
  const at = ledger.findIndex((e) => e.path === ev.path && sameRange(e.range, ev.range))
  if (at >= 0) ledger[at] = ev
  else ledger.push(ev)
  if (ledger.length > MAX_EVIDENCE_PER_NODE) ledger.splice(0, ledger.length - MAX_EVIDENCE_PER_NODE)
}

/** Most evidence records one node hands downstream (oldest dropped past this). */
const MAX_EVIDENCE_PER_NODE = 16
